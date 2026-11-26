/**
 * @file Shared startup cache warming for interactive and daemon ChELL hosts.
 *
 * Warms the VFS and process caches, reports each outcome through a small host
 * seam, and starts non-blocking job-topology warming after the jobs index is
 * available. Daemon startup waits for the blocking cache indexes before
 * publishing its listening berth; the steps warming behind the prompt settle
 * after it, with the daemon already answering, and so does the topology.
 *
 * @module
 */
import {
  error_stripDebugPrefix,
  prefetch_path,
  prefetchWithSpinner_run,
  repl_question,
  session,
  vfs,
  warmupFailure_clear,
  warmupFailure_note,
  warmupPending_clear,
  warmupPending_note,
  type BrasaEngine,
  type PrefetchResult,
  procUniverseModel_build,
  universeLayouts_warm,
  backend_get,
  type SessionIdentity,
} from '@fnndsc/brasa';
import { daemon_launch, identity_normalise, packageWebRoot_find, type DaemonLaunchInfo, hostControl_build, type HostControlInputs } from '@fnndsc/calypso';
import { CHELL_LAUNCH, daemonConsole_run, type DaemonConsoleTarget } from './daemonConsole.js';
import { logo_animateHalt } from '../lib/logo.js';
import { sink_set, StdoutSink, count_noun } from '@fnndsc/brasa';
import { TerminalProgressRenderer } from './progressRenderer.js';
import {
  errorStack,
  procCache_get,
  procCheckpoint_restore,
  procCheckpoint_watch,
  listCache_get,
  listCheckpoint_restore,
  listCheckpoint_watch,
  queryIndexCheckpoint_finish,
  queryIndexCheckpoint_hold,
  queryIndexCheckpoint_restore,
  queryIndexCheckpoint_save,
  queryIndexCheckpoint_watch,
  queryIndex_sweep,
  type ListCheckpointRestoreResult,
  type QueryIndexRestoreResult,
  type QuerySweepResult,
  type ProcCheckpointRestoreResult,
  type ProcWarmupProgress,
  type Result,
  type StackMessage,
} from '@fnndsc/cumin';
import { identityScope_run } from '@fnndsc/cumin/identity-epoch';
import type { ListingItem } from '@fnndsc/menu';
import {
  procCache_refresh,
  procRoster_bootSync,
  procRoster_sync,
  procTopology_status,
  procTopology_warmup,
  vfsDispatcher,
  type ProcTopologyStatus,
  procDataFacts_start,
} from '@fnndsc/salsa';
import { BOOT_TAG_WIDTH, type BootStatus } from '../lib/bootsequence.js';

/** Startup cache selections shared by interactive and daemon modes. */
export interface StartupWarmupFlags {
  plugins: boolean;
  feeds: boolean;
  publicFeeds: boolean;
  jobs: boolean;
}

/** Counts and failures produced by startup warming. */
export interface StartupWarmupCache {
  plugins?: number;
  pipelines?: number;
  feeds?: number;
  public?: number;
  /** Steps that blocked boot and exhausted their retries; these gate. */
  failures: string[];
  /** Steps warming behind the prompt. These do not gate: their outcome
   * arrives after the berth is published, so a failure is announced, and
   * while they run the prompt context names them as still warming. */
  deferred: DeferredWarmup[];
}

/** Minimal status reporter accepted by startup warming. */
export interface StartupWarmupReporter {
  log(status: BootStatus, label: string, message: string): void;
}

/** Number of attempts for a blocking startup cache operation. */
const STARTUP_WARMUP_ATTEMPTS: number = 3;
/** Brief backoff before the second and third startup attempts. */
const STARTUP_WARMUP_RETRY_DELAYS_MS: readonly number[] = [250, 500];

/** Operator choice after a daemon exhausts its startup retries. */
export type DaemonWarmupFailureDecision = 'continue' | 'exit';

/** Injectable operator-decision seam for daemon warm-up failures. */
export type DaemonWarmupRecovery = (failures: string[]) => Promise<DaemonWarmupFailureDecision>;

/** Sentinel used to prevent CALYPSO from binding after the operator exits boot. */
class DaemonWarmupAbortedError extends Error {}

/**
 * Waits briefly between transient startup attempts without retaining a timer.
 *
 * @param attempt - One-based attempt that just failed.
 * @returns Nothing after the corresponding retry delay.
 */
async function startupRetry_wait(attempt: number): Promise<void> {
  const delay: number = STARTUP_WARMUP_RETRY_DELAYS_MS[attempt - 1] ?? 0;
  if (delay === 0) return;
  await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, delay); });
}

/**
 * Runs one blocking warm-up action with a bounded retry policy.
 *
 * @param label - Stable boot-step label.
 * @param message - Description shown while the action is running.
 * @param interactive - Whether an interactive spinner may render.
 * @param reporter - Optional boot-status reporter.
 * @param action - One attempt at the cache operation.
 * @returns The first successful result, or the last failed result.
 */
async function startupPrefetch_retry(
  label: string,
  message: string,
  interactive: boolean,
  reporter: StartupWarmupReporter | null,
  action: () => Promise<PrefetchResult>,
): Promise<PrefetchResult> {
  return startupAttempts_run(
    label,
    reporter,
    (): Promise<PrefetchResult> => prefetchWithSpinner_run(label, message, interactive, action, BOOT_TAG_WIDTH),
  );
}

/**
 * Runs one warm-up attempt at a time under the bounded retry policy.
 *
 * Draws nothing itself: a blocking step wraps each attempt in the spinner
 * (or its plain-log stand-in), and a deferred step has already printed its
 * pending row and must not print another.
 *
 * @param label - Stable boot-step label.
 * @param reporter - Where retry rows go, or null to retry silently.
 * @param attempt - One attempt at the cache operation.
 * @returns The first successful result, or the last failed result.
 */
async function startupAttempts_run(
  label: string,
  reporter: StartupWarmupReporter | null,
  attempt: () => Promise<PrefetchResult>,
): Promise<PrefetchResult> {
  let last: PrefetchResult = { ok: false, message: 'Warm-up did not run.' };
  for (let turn: number = 1; turn <= STARTUP_WARMUP_ATTEMPTS; turn++) {
    last = await attempt();
    if (last.ok || turn === STARTUP_WARMUP_ATTEMPTS) return last;
    reporter?.log(
      'retry',
      label,
      `Attempt ${turn}/${STARTUP_WARMUP_ATTEMPTS} failed: ${last.message ?? 'unknown error'}; retrying.`,
    );
    await startupRetry_wait(turn);
  }
  return last;
}

/**
 * Asks a terminal operator whether a daemon with incomplete caches may start.
 *
 * A non-interactive launch retains the existing availability-first behavior:
 * it starts degraded rather than hanging or silently terminating.
 *
 * @param failures - Labels of cache steps that exhausted their retries.
 * @returns Whether to start degraded or exit before binding the daemon.
 */
async function daemonWarmupFailure_decide(failures: string[]): Promise<DaemonWarmupFailureDecision> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'continue';
  try {
    const answer: string = await repl_question(
      `Warm-up incomplete (${failures.join(', ')}). Continue with degraded caches? [c]ontinue/[E]xit: `,
    );
    return /^(c|continue)$/i.test(answer.trim()) ? 'continue' : 'exit';
  } catch {
    return 'exit';
  }
}

/** A warm-up running behind the prompt, with the label it reports under. */
export interface DeferredWarmup {
  label: string;
  settled: Promise<PrefetchResult>;
}

/**
 * Starts a warm-up behind the prompt instead of in front of it.
 *
 * The checkpoint restore has already put these listings in the cache, and
 * a stale one is served at once and refreshed behind, so blocking on the
 * fetch buys freshness that arrives anyway a moment later with nobody
 * waiting. Measured against a live CUBE: `/PUBLIC` costs 8.4s and
 * `/SHARED` 9.3s — eighteen seconds an operator spent watching a prompt
 * that could already have been theirs.
 *
 * A deferred step leaves the boot failure gate with this call, so its
 * failure is announced afterwards rather than holding the daemon. From its
 * start to its outcome it is held as still warming, which every surface
 * reads from the prompt context.
 *
 * The pending row is the only thing printed here. The attempts themselves
 * run without the spinner helper: its plain-log stand-in printed the same
 * label and message again, untagged, directly under the pending row.
 *
 * @param label - Stable boot-step label.
 * @param message - What the row says while it runs.
 * @param reporter - Host status logger, or null.
 * @param settlement - Whether the readout persists to take the outcome
 *   row: the daemon face keeps its boot log, so `[ OK ]` and `[FAIL]`
 *   land there when the step settles; an interactive readout has scrolled
 *   away, and the prompt carries a failure instead.
 * @param action - The warm-up itself.
 * @param describe - Words for a successful outcome's row.
 * @returns The step's label and the promise of its outcome.
 */
function warmup_defer(
  label: string,
  message: string,
  reporter: StartupWarmupReporter | null,
  settlement: boolean,
  action: () => Promise<PrefetchResult>,
  describe: (outcome: PrefetchResult) => string,
): DeferredWarmup {
  reporter?.log('pending', label, message);
  warmupPending_note(label);
  const outcomes: StartupWarmupReporter | null = settlement ? reporter : null;
  // A deferred step keeps the bounded retry policy a blocking one had: a
  // transient failure should be retried before it is announced.
  const settled: Promise<PrefetchResult> = startupAttempts_run(label, outcomes, action)
    .catch((error: unknown): PrefetchResult => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))
    .then((outcome: PrefetchResult): PrefetchResult => {
      warmupPending_clear(label);
      // A failure is held until a later attempt succeeds, so a surface
      // whose readout has scrolled away still announces it at the prompt.
      if (outcome.ok) {
        warmupFailure_clear(label);
        outcomes?.log('ok', label, describe(outcome));
      } else {
        const failure: string = outcome.message ?? `${label} warm-up failed`;
        warmupFailure_note(label, failure);
        outcomes?.log('fail', label, failure);
      }
      return outcome;
    });
  return { label, settled };
}

/**
 * Renders the age of the oldest restored folder listing.
 *
 * A restore's count says how much came back; its age says whether any of
 * it is worth having. Read after the restore, so the reported age is the
 * checkpoint's own, not this session's.
 *
 * @returns A leading-comma phrase such as `, oldest 3 days`, or an empty
 *   string when the cache holds nothing to age.
 */
function restoreAge_describe(): string {
  const oldest: number | null = listCache_get().stats_get().oldestAge;
  if (oldest === null) return '';
  const minutes: number = Math.floor(oldest / 60_000);
  if (minutes < 1) return ', all fresh';
  if (minutes < 60) return `, oldest ${minutes} min`;
  const hours: number = Math.floor(minutes / 60);
  if (hours < 48) return `, oldest ${count_noun(hours, 'hour')}`;
  return `, oldest ${count_noun(Math.floor(hours / 24), 'day')}`;
}


/**
 * The identity whose checkpoints this process may write, once a boot has
 * restored them.
 */
let flushIdentity: string | null = null;


/**
 * The connected session's identity, the name its checkpoints are kept under:
 * the same name the daemon's berth carries.
 *
 * @returns The normalised identity, or null when the session is not connected.
 */
async function sessionIdentity_name(): Promise<string | null> {
  const identity: SessionIdentity = await backend_get().session.identity_get();
  return identity.connected ? identity_normalise(identity.user, identity.where) : null;
}

/**
 * Restores the PACS replay index for a run that has no warm-up.
 *
 * `chell -c` and `chell -f` skip the boot warm-up entirely — the right call
 * for a one-shot, which should not walk a CUBE to answer one command. But
 * it left the replay index neither restored nor written, so a scripted
 * cohort re-asked the PACS every single time, and the audit workflow the
 * fan-out exists for was the one workflow replay never reached.
 *
 * Restoring is a file read of what a previous run already paid for; no
 * sweep, no CUBE call, no watcher — the flush at exit does the writing.
 *
 * @param user - The authenticated user, when there is one.
 */
export async function queryCheckpoint_prime(user: string | undefined): Promise<void> {
  if (session.offline || user === undefined) return;
  const identity: string | null = await sessionIdentity_name();
  if (identity === null) return;
  flushIdentity = identity;
  // The index in memory is this identity's from here: if it leaves during the run, it is written under its name.
  queryIndexCheckpoint_hold(identity);
  await queryIndexCheckpoint_restore(identity).catch((): QueryIndexRestoreResult => (
    { restored: false, count: 0 }
  ));
}

/**
 * Writes what this run learned about prior PACS queries, now.
 *
 * The checkpoint's own writer is debounced and its timer is unref'd, so a
 * one-shot `chell -c` exits before it fires — which meant a cohort asked by
 * a script was re-asked in full by the next script, the replay saving
 * nothing across exactly the boundary an audit workflow runs on. A
 * process that is about to exit flushes instead of hoping.
 *
 * Silent by design: nothing an operator asked for failed if this write did.
 */
export async function queryCheckpoint_flush(): Promise<void> {
  if (flushIdentity === null) return;
  // Each identity's index goes under its own name: one that left during the run was written as it left (and
  // is waited for here); what the index holds now is written for whoever is connected now, who may not be
  // the one the run began as.
  const now: string | null = await sessionIdentity_name().catch((): null => null);
  await queryIndexCheckpoint_finish(now).catch((): void => {
    /* the index rebuilds itself from CUBE on the next boot */
  });
}

/**
 * Warms startup caches and begins non-blocking job-topology warming.
 *
 * @param flags - Resource caches selected by the host's boot flags.
 * @param user - Authenticated username used to construct the feed path.
 * @param interactive - Whether progress may use an interactive spinner.
 * @param reporter - Host status logger, or null for silent status reporting.
 * @param reportSettlement - Whether to report outcomes that arrive after
 *   boot (the topology walk, the steps warming behind the prompt); daemon
 *   hosts enable this because the face keeps the readout, while interactive
 *   hosts use prompt progress.
 * @returns Cache counts and the labels of any failed warm-up operations.
 */
export async function startupWarmup_run(
  flags: StartupWarmupFlags,
  user: string | undefined,
  interactive: boolean,
  reporter: StartupWarmupReporter | null,
  reportSettlement: boolean = false,
): Promise<StartupWarmupCache> {
  // One piece of work, begun as whoever is connected at boot: the walks it leaves running behind the prompt
  // put nothing in the caches once someone else has connected.
  return identityScope_run((): Promise<StartupWarmupCache> => startupWarmup_walk(flags, user, interactive, reporter, reportSettlement));
}

/**
 * The warm-up itself: see {@link startupWarmup_run}, whose arguments these are.
 *
 * @param flags - Resource caches selected by the host's boot flags.
 * @param user - Authenticated username used to construct the feed path.
 * @param interactive - Whether progress may use an interactive spinner.
 * @param reporter - Host status logger, or null for silent status reporting.
 * @param reportSettlement - Whether to report outcomes that arrive after boot.
 * @returns Cache counts and the labels of any failed warm-up operations.
 *
 * @example
 * const cache: StartupWarmupCache = await startupWarmup_walk(flags, user, true, null, false);
 */
async function startupWarmup_walk(
  flags: StartupWarmupFlags,
  user: string | undefined,
  interactive: boolean,
  reporter: StartupWarmupReporter | null,
  reportSettlement: boolean,
): Promise<StartupWarmupCache> {
  const result: StartupWarmupCache = { failures: [], deferred: [] };
  /** The identity whose checkpoints this boot restored, once known. */
  let checkpointIdentity: string | null = null;

  // Feed movement dirties the listings inside a feed; an arrival or a
  // departure changes the folder a feed appears *in*. The roster speaks
  // only in feed ids, so the host names those folders once here, and says
  // which is which: a public feed landing must not dirty this identity's
  // own feeds folder. The shared and public roots are known without an
  // authenticated user; only the identity's own folder needs one.
  procCache_get().rosterFolders_set({
    ...(user !== undefined ? { owner: user, own: `/home/${user}/feeds` } : {}),
    shared: '/SHARED',
    public: '/PUBLIC',
  });

  // Folder listings survive a restart as a stale-marked checkpoint: the
  // first `ls` anywhere already listed renders at once and revalidates
  // behind itself. The row reports age as well as count, because a count
  // alone says nothing about whether the restore is worth having.
  if (!session.offline && user) {
    const identity: string | null = await sessionIdentity_name();
    if (identity !== null) {
      checkpointIdentity = identity;
      flushIdentity = identity;
      queryIndexCheckpoint_hold(identity);
      const listings: ListCheckpointRestoreResult = await listCheckpoint_restore(identity);
      listCheckpoint_watch(identity);
      reporter?.log(
        listings.restored ? 'ok' : 'skip',
        'Folders',
        listings.restored
          ? `Restored ${count_noun(listings.count, 'folder listing')}${restoreAge_describe()}, stale until revisited`
          : (listings.reason ?? 'No folder-listing checkpoint'),
      );
      // What has already been asked of a PACS. Expensive to build — every
      // row of the collection drags its compressed result — and cheap to
      // keep, so it is restored rather than swept again.
      const queries: QueryIndexRestoreResult = await queryIndexCheckpoint_restore(identity);
      queryIndexCheckpoint_watch(identity);
      reporter?.log(
        queries.restored ? 'ok' : 'skip',
        'Queries',
        queries.restored
          ? `Restored ${count_noun(queries.count, 'PACS query', 'PACS queries')} already asked`
          : (queries.reason ?? 'No PACS query index'),
      );
    }
  }

  if (!session.offline && flags.plugins) {
    const pluginsResult: PrefetchResult = await startupPrefetch_retry(
      'Plugins',
      'Prefetching /bin for completions',
      interactive,
      reporter,
      async (): Promise<PrefetchResult> => {
        const listingResult: Result<ListingItem[]> = await vfs.data_get('/bin');
        if (listingResult.ok) {
          return {
            ok: true,
            count: listingResult.value.filter((item: ListingItem): boolean => item.type === 'plugin').length,
            pipelineCount: listingResult.value.filter((item: ListingItem): boolean => item.type === 'pipeline').length,
          };
        }
        const error: StackMessage | undefined = errorStack.stack_pop();
        return { ok: false, message: error ? error_stripDebugPrefix(error.message) : 'Failed to prefetch /bin' };
      },
    );
    if (pluginsResult.ok) {
      result.plugins = pluginsResult.count;
      result.pipelines = pluginsResult.pipelineCount;
      reporter?.log('ok', 'Plugins', `Cached ${count_noun(pluginsResult.count ?? 0, 'plugin')}`);
      reporter?.log('ok', 'Pipelines', `Cached ${count_noun(pluginsResult.pipelineCount ?? 0, 'pipeline')}`);
    } else {
      result.failures.push('Plugins');
      reporter?.log('fail', 'Plugins', pluginsResult.message || 'Failed to prefetch /bin');
    }
  } else if (!session.offline) {
    reporter?.log('skip', 'Plugins', 'Prefetch disabled');
    reporter?.log('skip', 'Pipelines', 'Prefetch disabled');
  } else {
    reporter?.log('skip', 'Plugins', 'Offline mode');
    reporter?.log('skip', 'Pipelines', 'Offline mode');
  }

  if (!session.offline) {
    result.deferred.push(warmup_defer(
      'Groups',
      'Resolving /etc/group behind the prompt',
      reporter,
      reportSettlement,
      async (): Promise<PrefetchResult> => {
        const projection: Result<string> = await vfsDispatcher.read('/etc/group');
        if (projection.ok) {
          const count: number = projection.value.split('\n').filter(Boolean).length;
          return { ok: true, count };
        }
        const error: StackMessage | undefined = errorStack.stack_pop();
        return { ok: false, message: error?.message ?? 'Failed to resolve /etc/group' };
      },
      (outcome: PrefetchResult): string => `Cached ${count_noun(outcome.count ?? 0, 'group')}`,
    ));
  } else {
    reporter?.log('skip', 'Groups', 'Offline mode');
  }

  if (!session.offline && flags.feeds) {
    const feedPath: string | undefined = user ? `/home/${user}/feeds` : undefined;
    if (feedPath) {
      result.deferred.push(warmup_defer(
        'Feeds',
        `Warming ${feedPath} behind the prompt`,
        reporter,
        reportSettlement,
        (): Promise<PrefetchResult> => prefetch_path(feedPath),
        (outcome: PrefetchResult): string => `Cached ${count_noun(outcome.count ?? 0, 'item')} from ${feedPath}`,
      ));
    } else {
      reporter?.log('skip', 'Feeds', 'No user context');
    }

    if (flags.publicFeeds) {
      result.deferred.push(warmup_defer(
        'Public',
        'Warming /PUBLIC behind the prompt',
        reporter,
        reportSettlement,
        (): Promise<PrefetchResult> => prefetch_path('/PUBLIC'),
        (outcome: PrefetchResult): string => `Cached ${count_noun(outcome.count ?? 0, 'item')} from /PUBLIC`,
      ));
    }

    // `/SHARED` is where another identity's work becomes visible, and it
    // had no step at all: nothing to fail, so a CUBE that stopped serving
    // shared paths stayed silent until somebody went looking.
    result.deferred.push(warmup_defer(
      'Shared',
      'Warming /SHARED behind the prompt',
      reporter,
      reportSettlement,
      (): Promise<PrefetchResult> => prefetch_path('/SHARED'),
      (outcome: PrefetchResult): string => `Cached ${count_noun(outcome.count ?? 0, 'item')} from /SHARED`,
    ));

    // The PACS query back catalogue. It resumes from the index's floor, so
    // a restored index walks only what arrived since — and a cold one pays
    // the whole walk once, behind the prompt, never in front of a query.
    result.deferred.push(warmup_defer(
      'Queries',
      'Indexing prior PACS queries behind the prompt',
      reporter,
      reportSettlement,
      async (): Promise<PrefetchResult> => {
        // Every identity's queries, not just this one's: the index is also
        // the log that `/net/pacs/queries` lists, and that log has always
        // shown whatever CUBE holds. A replay stays scoped to the asking
        // identity by the index key, not by what was swept.
        const swept: Result<QuerySweepResult> = await queryIndex_sweep();
        if (!swept.ok) {
          const error: StackMessage | undefined = errorStack.stack_pop();
          return { ok: false, message: error?.message ?? 'Failed to index prior PACS queries' };
        }
        if (swept.value.bounded) {
          return {
            ok: false,
            message: `${count_noun(swept.value.total, 'PACS query', 'PACS queries')} indexed, stopped at the page bound — the index is incomplete`,
          };
        }
        // Made durable here rather than left to the debounced writer: that
        // timer is unref'd, so a one-shot `chell -c` would exit before it
        // fired and throw away a walk of the whole collection. The sweep is
        // the expensive thing; it is saved the moment it is worth saving.
        if (checkpointIdentity !== null) {
          await queryIndexCheckpoint_save(checkpointIdentity).catch((): void => {
            /* the debounced writer retries on the next mutation */
          });
        }
        return {
          ok: true,
          count: swept.value.total,
          pipelineCount: swept.value.indexed,
        };
      },
      // The amount of queries the index holds, and how many this top-up added
      // — a resume that found nothing new says just the total, not "1".
      (outcome: PrefetchResult): string => {
        const total: number = outcome.count ?? 0;
        const fresh: number = outcome.pipelineCount ?? 0;
        return `${count_noun(total, 'PACS query', 'PACS queries')} indexed${fresh > 0 ? `, ${fresh} new` : ''}`;
      },
    ));
  } else if (!session.offline) {
    reporter?.log('skip', 'Feeds', 'Prefetch disabled');
  } else {
    reporter?.log('skip', 'Feeds', 'Offline mode');
  }

  if (!session.offline && flags.jobs) {
    let checkpoint: ProcCheckpointRestoreResult | null = null;
    let rosterAdded: number[] = [];
    if (reportSettlement && user) {
      const identity: string | null = await sessionIdentity_name();
      if (identity !== null) {
        checkpoint = await procCheckpoint_restore(identity);
        procCheckpoint_watch(identity);
      }
    }
    // A cold boot's walk of the whole feed index (a page per hundred feeds,
    // each page CUBE's slowest list) runs behind the listening daemon, as a
    // restored roster's full walk does: in front of it, an identity that
    // sees thousands of feeds outlasted the door's wait and never booted
    // (#1280). A /proc read that arrives first joins the walk.
    let coldIndex: Promise<number[]> | null = null;
    const jobsResult: PrefetchResult = await startupPrefetch_retry(
      'Jobs',
      'Indexing /proc/jobs (feed list)...',
      interactive,
      reporter,
      async (): Promise<PrefetchResult> => {
        try {
          if (checkpoint?.restored) {
            // A restored roster goes into service on a delta (feeds newer
            // than the highest restored id).
            rosterAdded = await procRoster_bootSync();
          } else {
            coldIndex = procCache_refresh();
            coldIndex.catch((): void => {
              if (procCache_get().lifecycle_get().checkpointAt) procCache_get().cache_clear();
            });
          }
          return { ok: true, count: procCache_get().feedIDs_get().length };
        } catch (error: unknown) {
          if (procCache_get().lifecycle_get().checkpointAt) procCache_get().cache_clear();
          const message: string = error instanceof Error ? error.message : String(error);
          return { ok: false, message };
        }
      },
    );
    if (jobsResult.ok) {
      // A checkpoint that was there and refused is said, with why: a boot
      // that reads like a first boot hides a torn index (titan, 2026-10-05).
      const torn: number = checkpoint?.torn?.length ?? 0;
      const refused: boolean = checkpoint !== null && !checkpoint.restored && checkpoint.reason !== undefined && checkpoint.reason !== 'no checkpoint';
      const jobsMessage: string = checkpoint?.restored
        ? `Restored ${count_noun(checkpoint.count, 'job')}${checkpoint.migrated ? ' (checkpoint migrated to per-feed shards)' : ''}; ${count_noun(jobsResult.count ?? 0, 'feed')}, ${rosterAdded.length} new — full roster refresh in background${torn > 0 ? `; ${count_noun(torn, 'feed')} with a torn shard walks again` : ''}`
        : `${refused ? `Checkpoint refused (${checkpoint?.reason}); indexing` : 'Indexing'} the feed list in background — /proc/jobs fills in as it lands`;
      reporter?.log('ok', 'Jobs', jobsMessage);
      errorStack.scope_run((): void => {
        let topologySweep: Promise<void>;
        if (checkpoint?.restored) {
          // Restored topology is in service now; visits keep each feed
          // current. The full roster walk catches feeds that changed or
          // vanished while the daemon was away.
          procCache_get().warmup_complete();
          topologySweep = procRoster_sync(true).then((changed: number[]): void => {
            if (changed.length > 0) {
              reporter?.log('ok', 'Roster', `${count_noun(changed.length, 'feed')} moved while away; each refreshes on its next visit`);
            }
            // No sweep runs after a restore, so its tails do not either:
            // what each feed's data is gets read here, quietly, for any feed
            // the checkpoint does not yet know it for.
            void procDataFacts_start();
          });
        } else {
          const index: Promise<number[]> = coldIndex ?? Promise.resolve([]);
          topologySweep = index.then((): Promise<void> => procTopology_warmup());
        }
        // The index whole, the session lays the universe out once for every
        // surface (in a worker thread, off the lane); a layout it already
        // keeps is left as it is.
        void topologySweep.then((): void => {
          if (procTopology_status().state !== 'complete') return;
          void universeLayouts_warm(() => procUniverseModel_build().feeds);
        }, (): void => { /* no index, no layout */ });
        if (reportSettlement) {
          void topologySweep.then(
            (): void => {
              const topology: ProcTopologyStatus = procTopology_status();
              if (topology.state !== 'complete') {
                reporter?.log('fail', 'Topology', `Warm-up failed: ${topology.failure ?? 'the topology index did not complete'}`);
                return;
              }
              const progress: ProcWarmupProgress = procCache_get().warmupProgress_get();
              const total: number = progress.total > 0 ? progress.total : progress.loaded;
              reporter?.log('ok', 'Topology', `Ready — ${progress.loaded}/${count_noun(total, 'job')} indexed`);
            },
            (error: unknown): void => {
              const message: string = error instanceof Error ? error.message : String(error);
              reporter?.log('fail', 'Topology', `Warm-up failed: ${message}`);
            },
          );
        } else {
          void topologySweep.catch((): void => { /* failure is visible through proc lifecycle state */ });
        }
      });
    } else {
      result.failures.push('Jobs');
      reporter?.log('fail', 'Jobs', jobsResult.message || 'Failed to index /proc/jobs');
    }
  } else if (!session.offline) {
    reporter?.log('skip', 'Jobs', 'Prefetch disabled');
  } else {
    reporter?.log('skip', 'Jobs', 'Offline mode');
  }

  return result;
}

/**
 * Warms a connected engine, publishes its daemon, then reports readiness.
 *
 * The blocking warm-up (`/bin`, the job index's first step) gates the
 * daemon: its failure is the operator's to decide on before anything binds.
 * The steps warming behind the prompt do not: the daemon listens and writes
 * its berth file while they run, so a door waiting on that file is not held
 * by a `/PUBLIC` listing or a cold PACS query index, and a surface that
 * attaches meanwhile is answered and told what is still warming. Engine
 * Ready is said when the last of them settles.
 *
 * @param engine - Connected BRASA engine to host.
 * @param user - Authenticated username used for feed warming.
 * @param flags - Resource caches selected by daemon boot flags.
 * @param interactive - Whether progress may use an interactive spinner.
 * @param reporter - Daemon boot status logger.
 * @param recovery - Asks the operator what to do after an exhausted warm-up.
 * @param hostControlInputs - The host-control policy inputs.
 * @param console - Puts a surface on this terminal once the daemon is up;
 *   the daemon console by default, replaceable under test.
 */
export async function daemonSession_run(
  engine: BrasaEngine,
  user: string | undefined,
  flags: StartupWarmupFlags,
  interactive: boolean,
  reporter: StartupWarmupReporter,
  recovery: DaemonWarmupRecovery = daemonWarmupFailure_decide,
  hostControlInputs: HostControlInputs = {},
  console: (target: DaemonConsoleTarget) => Promise<void> = daemonConsole_run,
): Promise<void> {
  try {
    // Warm-up runs before the daemon installs its own sink, so the engine is
    // still writing to this terminal — and a daemon boot is the one time
    // anyone watches it. Without a renderer the migrated spinner emits typed
    // events into StdoutSink's null renderer and the boot looks frozen.
    if (interactive) {
      sink_set(new StdoutSink(new TerminalProgressRenderer()));
    }
    const parsedPolicy = hostControl_build(hostControlInputs);
    if ('error' in parsedPolicy) {
      reporter.log('fail', 'Daemon', parsedPolicy.error);
      throw new DaemonWarmupAbortedError();
    }
    // What the gate leaves behind it: the steps still warming, and whether
    // the gate already said how the engine starts.
    const boot: { deferred: DeferredWarmup[]; gated: boolean } = { deferred: [], gated: false };
    const info: DaemonLaunchInfo = await daemon_launch(engine, async (): Promise<void> => {
      const cache: StartupWarmupCache = await startupWarmup_run(flags, user, interactive, reporter, true);
      boot.deferred = cache.deferred;
      if (cache.failures.length === 0) {
        // The steps behind the prompt go on with the daemon listening.
        const warming: number = boot.deferred.length;
        reporter.log(
          warming === 0 ? 'ok' : 'pending',
          'Engine',
          warming === 0 ? 'Ready' : `${count_noun(warming, 'step')} warming behind the prompt; the daemon answers meanwhile`,
        );
        return;
      }

      boot.gated = true;

      if (await recovery(cache.failures) === 'exit') {
        reporter.log('fail', 'Engine', `Startup aborted after incomplete warm-up: ${cache.failures.join(', ')}`);
        throw new DaemonWarmupAbortedError();
      }
      reporter.log('fail', 'Engine', `Starting with incomplete warm-up: ${cache.failures.join(', ')}`);
    }, {
      hostControl: parsedPolicy.policy,
      // chell's surface is ARGUS: the bundle the installed @fnndsc/argus ships.
      webRoot: packageWebRoot_find('@fnndsc/argus', import.meta.url),
      // A browser's terminal runs this very chell, not one found on the path.
      surfaceLaunch: CHELL_LAUNCH,
    });

    // The addresses are printed: the pulse halts without a final repaint,
    // since its row arithmetic drifts over them, while the steps still
    // warming settle their rows beneath.
    if (interactive) logo_animateHalt();

    // The steps warming behind the prompt settle on the readout with the
    // daemon already answering. The login waits them out before it takes
    // the terminal, so every row the operator is left looking at reads
    // [ OK ] or [FAIL], never an open [PENDING] the console would cage
    // before it could finish. The wait is bounded: each step carries its
    // own retry budget.
    await Promise.allSettled(boot.deferred.map((step: DeferredWarmup): Promise<PrefetchResult> => step.settled));
    if (!boot.gated && boot.deferred.length > 0) reporter.log('ok', 'Engine', 'Ready');

    if (interactive) {
      // Boot is over, and ends the way a boot should: at a login. The
      // identity is already resolved, so the login is the attach, and this
      // terminal becomes the daemon's first surface.
      await console({ identity: info.identity, url: info.url, token: info.token });
    }
  } catch (error: unknown) {
    if (error instanceof DaemonWarmupAbortedError) {
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
