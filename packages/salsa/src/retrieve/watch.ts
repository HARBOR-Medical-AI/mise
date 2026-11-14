/**
 * @file PACS retrieve engine: fire, watch, confirm.
 *
 * The single implementation of "make DICOM series land in CUBE and know when
 * they have": synthetic query+retrieve firing with bounded concurrency and
 * per-step retry, a LONK WebSocket watch with stall/timeout/no-activity
 * detection, storage-side confirmation across registration lag, and an
 * optional refire loop for unconfirmed series. Both consumers (the `pull`
 * builtin in brasa and the PACS VFS provider's `cp`) previously solved this
 * independently — LONK push versus 5-second polling — with different
 * semantics; this module is the convergence (docs/code-audit-2026-08.adoc,
 * decisions section).
 *
 * The engine is presentation-free: progress is reported through the
 * {@link RetrieveWatchEvents} callbacks and consumers render it however their
 * surface renders (structured sink progress, plain console lines).
 *
 * @module
 */
import WebSocket from 'ws';
import {
  pacsQueries_create,
  pacsRetrieve_create,
  seriesStorage_resolve,
  retry_untilValue,
  downloadToken_create,
  type DownloadToken,
  type PACSQueryCreateData,
  type PACSRetrieveRecord,
  type SeriesStorageState,
  type Result,
  type Client,
} from '@fnndsc/cumin';

/**
 * Lifecycle states of one series retrieve.
 *
 * `unconfirmed` is the state of a series the client stopped watching before it
 * could see the end. It is not a failure: the PACS keeps pushing and CUBE keeps
 * registering after a watch ends, so the retrieve is very likely still running
 * or already done. Reporting such a series as `error` claims knowledge the
 * client does not have, and a caller that treats it as failure will tell an
 * operator that nothing arrived while the files land behind them.
 */
export type RetrieveStatus =
  | 'pending' | 'pulling' | 'pulled' | 'stalled' | 'timeout' | 'error' | 'unfired' | 'unconfirmed';

/** Progress classification reported to event consumers. */
export type RetrieveProgressStatus = 'running' | 'done' | 'unconfirmed' | 'error' | 'stalled' | 'timeout';

/** Concurrent retrieve creations; more overloads CUBE and loses retrieves. */
const FIRE_CONCURRENCY: number = 4;
/** Retry attempts for one retrieve creation, with backoff between them. */
const FIRE_ATTEMPTS: number = 3;
const FIRE_BACKOFF_MS: readonly number[] = [250, 500];
/**
 * Reconnection attempts for a dropped LONK socket.
 *
 * A long retrieve gives a socket more chances to die, which is why a large
 * study failed where a small one did not. The retrieves are unaffected by the
 * loss, so reconnecting resumes reporting rather than repeating work.
 */
const WATCH_RECONNECT_ATTEMPTS: number = 3;

const STALL_TIMEOUT_MS: number = 30_000;
// A hospital PACS can take most of a minute to begin sending, more when
// several series are queued: fifteen seconds called many a series lost
// that was simply waiting its turn.
const NO_ACTIVITY_TIMEOUT_MS: number = 60_000;
// With someone to ask, the question comes sooner and repeats: twenty
// seconds of silence, CUBE checked, then "keep waiting?".
const ASK_AFTER_MS: number = 20_000;
const SERIES_TIMEOUT_MS: number = 5 * 60 * 1_000;
const CHECKER_INTERVAL_MS: number = 2_000;

/**
 * Runtime state for a single series being retrieved.
 *
 * @property label - Display label for progress and summaries.
 * @property seriesUID - DICOM SeriesInstanceUID.
 * @property studyUID - DICOM StudyInstanceUID.
 * @property pacsName - PACS identifier (`pacs_name` for LONK subscriptions).
 * @property expectedFiles - File count from the originating query decode.
 * @property syntheticQueryId - ID of the per-series synthetic PACSQuery.
 * @property retrieveId - ID of the PACSRetrieve created for it.
 * @property status - Current lifecycle status.
 * @property actualFiles - Most recent file count from LONK progress updates.
 * @property lastProgressFiles - `actualFiles` at the last progress tick (stall detection).
 * @property lastProgressTime - Timestamp of the last progress tick.
 * @property firstFileTime - When this series' first file arrived; 0 while it
 *   is still waiting its turn. The long stop counts from here, so a series
 *   queued behind a dozen others is not charged for the wait.
 * @property startTime - Timestamp when the retrieve was fired.
 * @property lonkConfirmed - True only after an explicit LONK `done` or a storage confirmation.
 * @property cubePathDir - CUBE folder the series landed in (resolved post-pull).
 * @property reason - Why a series ended badly, in words a surface can show
 *   (an ERROR that cannot say why is the defect this field closes).
 */
export interface RetrieveTask {
  label: string;
  seriesUID: string;
  studyUID: string;
  pacsName: string;
  expectedFiles: number;
  syntheticQueryId: number | null;
  retrieveId: number | null;
  status: RetrieveStatus;
  actualFiles: number;
  lastProgressFiles: number;
  lastProgressTime: number;
  firstFileTime: number;
  startTime: number;
  lonkConfirmed: boolean;
  cubePathDir: string | null;
  reason?: string;
}

/**
 * Consumer callbacks for engine progress.
 *
 * @property task - One series changed state or progressed.
 * @property retryRound - A refire round for unconfirmed series is starting.
 */
export interface RetrieveWatchEvents {
  task?: (task: RetrieveTask, status: RetrieveProgressStatus, phase: 'watching' | 'retrying') => void;
  retryRound?: (attempt: number, retryMax: number, count: number) => void;
  /**
   * The watch socket dropped and is being reopened. Reported because a silent
   * reconnection during a long pull looks identical to a stall.
   */
  reconnect?: (attempt: number, maxAttempts: number, watching: number) => void;
  /**
   * The PACS has sent nothing for a while and CUBE does not have these
   * series either: whether to keep waiting. A surface that can be asked
   * answers it (the operator decides, never a timer). A caller with nobody
   * to ask (a script, a line in the background) leaves this out: the watch
   * waits its longer window and calls the silent series unconfirmed.
   *
   * @param waiting - The series still waiting on a first file.
   * @param waitedS - How long the PACS has been silent, in seconds: the whole
   *   silence, however many times the answer was to keep waiting.
   * @returns True to keep waiting another window.
   */
  stillWaiting?: (waiting: RetrieveTask[], waitedS: number) => Promise<boolean>;
}


/**
 * Builds a fresh retrieve task from series identity facts.
 *
 * @param info - Label, UIDs, PACS name, and expected file count.
 * @returns A pending task ready for {@link retrieve_fireAndWatch}.
 */
export function retrieveTask_make(info: {
  label: string;
  seriesUID: string;
  studyUID: string;
  pacsName: string;
  expectedFiles: number;
}): RetrieveTask {
  return {
    ...info,
    syntheticQueryId: null,
    retrieveId: null,
    status: 'pending',
    actualFiles: 0,
    lastProgressFiles: 0,
    lastProgressTime: Date.now(),
    firstFileTime: 0,
    startTime: 0,
    lonkConfirmed: false,
    cubePathDir: null,
  };
}

/**
 * Classifies a task's state for progress reporting.
 *
 * @param task - The task to classify.
 * @returns The progress status consumers render.
 */
export function retrieveProgress_classify(task: RetrieveTask): RetrieveProgressStatus {
  if (task.status === 'pulled') return task.lonkConfirmed ? 'done' : 'unconfirmed';
  if (task.status === 'pending' || task.status === 'pulling') return 'running';
  if (task.status === 'unfired') return 'error';
  return task.status;
}

/**
 * Marks tasks whose series are already fully registered in CUBE as pulled,
 * so firing skips them. This is what makes a retrieve idempotent: re-running
 * the same request after a partial failure fetches only the missing series.
 *
 * @param tasks - All tasks; complete ones are mutated to pulled.
 * @returns How many tasks were marked complete and skipped.
 */
export async function retrieveTasks_skipComplete(tasks: RetrieveTask[]): Promise<number> {
  let skipped: number = 0;
  await Promise.all(tasks.map(async (task: RetrieveTask): Promise<void> => {
    const stateResult: Result<SeriesStorageState> = await seriesStorage_resolve(task.seriesUID);
    if (!stateResult.ok) return;
    const state: SeriesStorageState = stateResult.value;
    if (task.expectedFiles > 0 && state.fileCount >= task.expectedFiles && state.folderPath !== null) {
      task.status = 'pulled';
      task.lonkConfirmed = true;
      task.actualFiles = state.fileCount;
      task.cubePathDir = state.folderPath;
      skipped++;
    }
  }));
  return skipped;
}

/**
 * Creates a synthetic PACSQuery + PACSRetrieve for a single series, with
 * bounded retry: creation failures during a server brown-out are permanent
 * data loss for the run (nothing ever retrieves), so each series gets a few
 * attempts before it is declared unfired.
 *
 * @param task - The task to fire (mutated: syntheticQueryId, retrieveId, startTime, status).
 * @param pacsserver - Resolved PACS server ID string.
 */
async function task_fire(task: RetrieveTask, pacsserver: string): Promise<void> {
  const fired: { queryId: number; retrieveId: number } | null = await retry_untilValue(
    FIRE_ATTEMPTS,
    FIRE_BACKOFF_MS,
    async (): Promise<{ queryId: number; retrieveId: number } | null> => {
      const queryData: PACSQueryCreateData = {
        // CUBE rejects duplicate query titles per user; a timestamp keeps
        // re-pull titles unique.
        title: `pull_${task.seriesUID}_${Date.now().toString(36)}`,
        query: JSON.stringify({
          SeriesInstanceUID: task.seriesUID,
          StudyInstanceUID: task.studyUID,
        }),
        execute: false,
      };
      const queryResult = await pacsQueries_create(pacsserver, queryData);
      if (!queryResult.ok) return null;
      const retrieveResult = await pacsRetrieve_create(queryResult.value.id);
      if (!retrieveResult.ok) return null;
      return { queryId: queryResult.value.id, retrieveId: (retrieveResult.value as PACSRetrieveRecord).id };
    },
  );

  if (fired === null) {
    task.status = 'unfired';
    task.reason = `the retrieve could not be started: CUBE refused the query or the retrieve ${FIRE_ATTEMPTS} times`;
    return;
  }
  task.syntheticQueryId = fired.queryId;
  task.retrieveId = fired.retrieveId;
  task.startTime = Date.now();
}

/**
 * Fires retrieves with bounded concurrency, so a large study does not
 * stampede CUBE with parallel creations (the overload that loses retrieves
 * in the first place).
 *
 * @param tasks - Tasks to fire.
 * @param pacsserver - Resolved PACS server identifier.
 */
async function tasks_fireBounded(tasks: RetrieveTask[], pacsserver: string): Promise<void> {
  let next: number = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task: RetrieveTask = tasks[next++];
      await task_fire(task, pacsserver);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FIRE_CONCURRENCY, tasks.length) }, () => worker()));
}

/**
 * Fires retrieves for tasks (bounded, retried) without watching: the
 * fire-and-exit path (`pull --nowait`). Tasks that could not fire are left
 * in the `unfired` state.
 *
 * @param tasks - Tasks to fire.
 * @param pacsserver - Resolved PACS server identifier.
 */
export async function retrieveTasks_fire(tasks: RetrieveTask[], pacsserver: string): Promise<void> {
  await tasks_fireBounded(tasks, pacsserver);
}

/**
 * Constructs a LONK WebSocket URL from a download token response.
 *
 * @param tokenUrl - The download token resource URL.
 * @param token - The actual download token string.
 * @returns WebSocket URL for the LONK endpoint.
 */
function lonkWsUrl_build(tokenUrl: string, token: string): string {
  return tokenUrl
    .replace(/^http(s?):\/\//, (_m: string, s: string) => `ws${s}://`)
    .replace(/v1\/downloadtokens\/\d+\//, `v1/pacs/ws/?token=${token}`);
}

/**
 * Opens a LONK WebSocket, fires retrieves for the tasks, and blocks until
 * every task reaches a terminal state. Mutates each task's status,
 * actualFiles, and lonkConfirmed; reports progress through the events.
 *
 * @param tasks - Tasks to subscribe, fire, and watch.
 * @param pacsserver - Resolved PACS server identifier.
 * @param client - Authenticated ChRIS API client (for the LONK token).
 * @param events - Progress callbacks.
 * @param phase - Phase tag passed through to task events.
 * @returns Number of tasks whose retrieve could not be fired.
 */
export async function retrieve_fireAndWatch(
  tasks: RetrieveTask[],
  pacsserver: string,
  client: Client,
  events: RetrieveWatchEvents = {},
  phase: 'watching' | 'retrying' = 'watching',
): Promise<number> {
  const emit = (task: RetrieveTask, status?: RetrieveProgressStatus): void => {
    events.task?.(task, status ?? retrieveProgress_classify(task), phase);
  };

  const downloadToken: DownloadToken = await downloadToken_create(client);
  const lonkUrl: string = lonkWsUrl_build(downloadToken.url, downloadToken.token);

  /**
   * Opens a LONK socket and subscribes it to the series given.
   *
   * A reconnect subscribes only what is still in flight: the retrieves are
   * already running on the server, so re-firing them would duplicate work that
   * was never lost.
   */
  const socket_open = async (subscribe: RetrieveTask[]): Promise<WebSocket> => {
    const socket: WebSocket = new WebSocket(lonkUrl);
    await new Promise<void>((openResolve: () => void, openReject: (err: Error) => void) => {
      socket.once('open', openResolve);
      socket.once('error', (err: Error) => openReject(err));
    });
    for (const t of subscribe) {
      socket.send(JSON.stringify({ SeriesInstanceUID: t.seriesUID, pacs_name: t.pacsName, action: 'subscribe' }));
    }
    return socket;
  };

  let ws: WebSocket = await socket_open(tasks);

  await tasks_fireBounded(tasks, pacsserver);

  const fired: RetrieveTask[] = tasks.filter((t: RetrieveTask) => t.status !== 'unfired');
  const firingErrors: number = tasks.length - fired.length;

  if (fired.length === 0) {
    for (const t of tasks) {
      if (t.status === 'unfired') emit(t, 'error');
    }
    ws.close();
    return firingErrors;
  }

  for (const t of tasks) {
    emit(t, t.status === 'unfired' ? 'error' : 'running');
  }

  const taskByUID: Map<string, RetrieveTask> = new Map(
    tasks.map((t: RetrieveTask): [string, RetrieveTask] => [t.seriesUID, t]),
  );

  await new Promise<void>((resolve: () => void) => {
    let resolved: boolean = false;
    let reconnectsLeft: number = WATCH_RECONNECT_ATTEMPTS;
    // When this watch last saw life from the PACS, on ANY of its series.
    // Quiet is a property of the watch, not of each series: a PACS busy
    // sending the first series has not gone silent on the ten queued
    // behind it, and they cannot report files they have not been sent yet.
    let lastActivityAt: number = Date.now();
    // When the PACS last sent anything. A yes to "keep waiting?" restarts
    // the clock above, which times the next question; it does not make
    // the PACS any less silent, and this is the silence the question says.
    let quietSince: number = lastActivityAt;
    // While the operator is being asked, the silence rule holds its tongue.
    let asking: boolean = false;
    const done = (): void => {
      if (resolved) return;
      resolved = true;
      clearInterval(checker);
      try { ws.close(); } catch { /* best-effort socket cleanup */ }
      resolve();
    };

    /** The series this watch is still waiting on. */
    const inFlight = (): RetrieveTask[] =>
      fired.filter((t: RetrieveTask) => t.status === 'pending' || t.status === 'pulling');

    /**
     * Replaces a dead socket, or gives up and records what is unknown.
     *
     * A LONK socket carries no state a client cannot rebuild: the retrieves run
     * on the server regardless, and a fresh subscription resumes reporting on
     * them. Only when reconnection is exhausted does the watch admit it stopped
     * looking — and even then it says so rather than calling the retrieves
     * failed.
     */
    const socket_replace = (): void => {
      if (resolved) return;
      const remaining: RetrieveTask[] = inFlight();
      if (remaining.length === 0) {
        done();
        return;
      }
      if (reconnectsLeft <= 0) {
        for (const t of remaining) {
          t.status = 'unconfirmed';
          emit(t, 'unconfirmed');
        }
        done();
        return;
      }
      reconnectsLeft -= 1;
      events.reconnect?.(WATCH_RECONNECT_ATTEMPTS - reconnectsLeft, WATCH_RECONNECT_ATTEMPTS, remaining.length);
      void socket_open(remaining)
        .then((replacement: WebSocket): void => {
          if (resolved) {
            try { replacement.close(); } catch { /* the watch already ended */ }
            return;
          }
          ws = replacement;
          // A reconnection is a new view, not new silence: charging the
          // gap to the PACS would declare the study dead on reconnect.
          lastActivityAt = Date.now();
          quietSince = lastActivityAt;
          socket_listen();
        })
        .catch((): void => socket_replace());
    };

    const checker: NodeJS.Timeout = setInterval(() => {
      const now: number = Date.now();
      let allTerminal: boolean = true;

      for (const t of fired) {
        if (t.status === 'pulled' || t.status === 'error' || t.status === 'unfired' || t.status === 'stalled' || t.status === 'timeout' || t.status === 'unconfirmed') {
          continue;
        }
        allTerminal = false;

        // A series that began and then stopped is stalled on its own
        // evidence: it was being sent, and it no longer is.
        if (t.actualFiles > 0 && now - t.lastProgressTime > STALL_TIMEOUT_MS) {
          t.status = 'stalled';
          emit(t, 'stalled');
          continue;
        }

        // The long stop: a series that trickles and never ends. Counted
        // from its first file, never from the fire, so waiting a turn in a
        // large study costs a series nothing.
        if (t.firstFileTime > 0 && now - t.firstFileTime > SERIES_TIMEOUT_MS) {
          t.status = 'timeout';
          emit(t, 'timeout');
          continue;
        }

        // Nothing has arrived for this series. That is evidence of a lost
        // retrieve only when nothing has arrived for ANY of them. Charged
        // per series from its own fire time, this declared every series
        // after the first few dead fifteen seconds into any study large
        // enough that the PACS served them in turn.
        if (events.stillWaiting === undefined && t.startTime > 0 && t.actualFiles === 0 && now - lastActivityAt > NO_ACTIVITY_TIMEOUT_MS) {
          t.status = 'pulled';
          t.lonkConfirmed = false;
          emit(t, 'unconfirmed');
          continue;
        }
      }

      if (allTerminal) { done(); return; }

      // With someone to ask: after a short silence, CUBE first (a series
      // may have landed unseen), then the operator decides whether to keep
      // waiting for the rest.
      const ask = events.stillWaiting;
      if (ask !== undefined && !asking && now - lastActivityAt > ASK_AFTER_MS) {
        const silent: RetrieveTask[] = fired.filter((t: RetrieveTask) => t.status === 'pending' && t.startTime > 0 && t.actualFiles === 0);
        if (silent.length === 0) return;
        asking = true;
        const silenceStart: number = lastActivityAt;
        void (async (): Promise<void> => {
          await Promise.all(silent.map(async (t: RetrieveTask): Promise<void> => {
            const stateResult: Result<SeriesStorageState> = await seriesStorage_resolve(t.seriesUID);
            if (stateResult.ok && stateResult.value.folderPath !== null && t.status === 'pending') {
              t.status = 'pulled';
              t.lonkConfirmed = true;
              t.cubePathDir = stateResult.value.folderPath;
              t.actualFiles = stateResult.value.fileCount;
              emit(t, 'done');
            }
          }));
          const waiting: RetrieveTask[] = silent.filter((t: RetrieveTask) => t.status === 'pending');
          // Files arrived while CUBE was asked: the question is moot.
          if (waiting.length === 0 || lastActivityAt !== silenceStart || resolved) { asking = false; return; }
          const keep: boolean = await ask(waiting, Math.round((Date.now() - quietSince) / 1000)).catch((): boolean => false);
          if (resolved) return;
          if (keep || lastActivityAt !== silenceStart) {
            lastActivityAt = Date.now();
          } else {
            for (const t of waiting) {
              if (t.status !== 'pending') continue;
              t.status = 'unconfirmed';
              t.reason = 'stopped waiting: the PACS had sent nothing and CUBE had none of it';
              emit(t, 'unconfirmed');
            }
          }
          asking = false;
        })();
      }
    }, CHECKER_INTERVAL_MS);

    /** Attaches this watch's handlers to whichever socket is current. */
    const socket_listen = (): void => {
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const outer: Record<string, unknown> = JSON.parse(data.toString()) as Record<string, unknown>;
        const seriesUID: string | undefined = outer.SeriesInstanceUID as string | undefined;
        const message: Record<string, unknown> | undefined = outer.message as Record<string, unknown> | undefined;
        if (!seriesUID || !message) return;

        const t: RetrieveTask | undefined = taskByUID.get(seriesUID);
        if (!t) return;

        lastActivityAt = Date.now();
        quietSince = lastActivityAt;
        if ('ndicom' in message && typeof message.ndicom === 'number') {
          const n: number = message.ndicom;
          t.actualFiles = n;
          t.lastProgressFiles = n;
          t.lastProgressTime = Date.now();
          if (t.firstFileTime === 0 && n > 0) t.firstFileTime = t.lastProgressTime;
          if (t.status === 'pending') t.status = 'pulling';
          emit(t, 'running');
        } else if ('done' in message && message.done === true) {
          t.status = 'pulled';
          t.lonkConfirmed = true;
          if (t.actualFiles < t.expectedFiles) t.actualFiles = t.expectedFiles;
          emit(t, 'done');
        } else if ('error' in message && typeof message.error === 'string') {
          t.status = 'error';
          t.reason = `the receiver could not store a file: ${message.error}`;
          emit(t, 'error');
        }
      } catch {
        // Deliberate absorption: a malformed LONK frame carries no correlation
        // to fail; the checker's stall/timeout guards still bound the watch.
      }
    });

    // A dead socket is a lost view, not a lost retrieve: reconnect and keep
    // watching. Only when that fails repeatedly does the watch stop, and even
    // then it records what it no longer knows rather than declaring failure.
    ws.on('error', () => { socket_replace(); });
    ws.on('close', () => { socket_replace(); });
    };

    socket_listen();
  });

  return firingErrors;
}

/**
 * Confirms unconfirmed series against CUBE storage and refires the rest, up
 * to `retryMax` rounds; series still unconfirmed afterwards are marked
 * errored. This closes the gap between a lost LONK confirmation (cosmetic)
 * and a retrieve that genuinely never delivered (real loss).
 *
 * @param allTasks - All tasks from the initial watch.
 * @param retryMax - Maximum refire rounds.
 * @param pacsserver - The PACS server identifier.
 * @param client - The connected ChRIS client.
 * @param events - Progress callbacks.
 * @returns The number of additional firing errors incurred.
 */
export async function retrieve_confirmLoop(
  allTasks: RetrieveTask[],
  retryMax: number,
  pacsserver: string,
  client: Client,
  events: RetrieveWatchEvents = {},
): Promise<number> {
  let extraFiringErrors: number = 0;
  // A series the watch lost sight of is a candidate for exactly the same
  // treatment as one whose confirmation went missing: ask CUBE. Both are
  // "we did not see the end", and CUBE is the only thing that knows.
  let retryCandidates: RetrieveTask[] = allTasks.filter(
    (t: RetrieveTask) => (t.status === 'pulled' && !t.lonkConfirmed) || t.status === 'unconfirmed',
  );
  // The series the watch gave up on because the PACS sent nothing at all,
  // as distinct from the ones it lost sight of: each ends differently in
  // words.
  const silent: Set<RetrieveTask> = new Set(
    retryCandidates.filter((t: RetrieveTask) => t.status === 'pulled' && t.actualFiles === 0),
  );

  /** Asks CUBE about each candidate; a series found there arrived. */
  const storage_ask = async (tasks: RetrieveTask[]): Promise<void> => {
    await Promise.all(tasks.map(async (t: RetrieveTask): Promise<void> => {
      const stateResult: Result<SeriesStorageState> = await seriesStorage_resolve(t.seriesUID);
      if (stateResult.ok && stateResult.value.folderPath !== null) {
        t.lonkConfirmed = true;
        t.cubePathDir = stateResult.value.folderPath;
        // A series found in CUBE arrived, whatever the watch managed to see.
        t.status = 'pulled';
        t.actualFiles = stateResult.value.fileCount;
        events.task?.(t, 'done', 'retrying');
      }
    }));
  };

  // CUBE is asked at least once, whatever the retry count: with no retries
  // the loop below never ran, and every series the watch had not seen
  // finish was declared an error unasked, while its files were landing.
  await storage_ask(retryCandidates);
  retryCandidates = retryCandidates.filter((t: RetrieveTask) => !t.lonkConfirmed);

  let refired: boolean = false;
  for (let attempt: number = 1; attempt <= retryMax && retryCandidates.length > 0; attempt++) {
    events.retryRound?.(attempt, retryMax, retryCandidates.length);
    refired = true;

    for (const t of retryCandidates) {
      t.status = 'pending';
      t.actualFiles = 0;
      t.lastProgressFiles = 0;
      t.lastProgressTime = Date.now();
      t.firstFileTime = 0;
      t.startTime = 0;
      t.lonkConfirmed = false;
      t.syntheticQueryId = null;
      t.retrieveId = null;
      events.task?.(t, 'running', 'retrying');
    }

    extraFiringErrors += await retrieve_fireAndWatch(retryCandidates, pacsserver, client, events, 'retrying');

    retryCandidates = retryCandidates.filter(
      (t: RetrieveTask) => (t.status === 'pulled' && !t.lonkConfirmed) || t.status === 'unconfirmed',
    );
    await storage_ask(retryCandidates);
    retryCandidates = retryCandidates.filter((t: RetrieveTask) => !t.lonkConfirmed);
  }

  for (const t of retryCandidates) {
    if (refired) {
      // Fired again and still nowhere in CUBE: that is a failure observed.
      t.status = 'error';
      t.reason = `nothing reached CUBE after ${retryMax} more ${retryMax === 1 ? 'try' : 'tries'}`;
      events.task?.(t, 'error', 'retrying');
    } else {
      // Not seen to finish and not in CUBE yet: unknown, not failed. A
      // PACS slow to begin keeps sending after the watch ends.
      t.status = 'unconfirmed';
      t.reason ??= silent.has(t)
        ? `the PACS sent nothing for ${NO_ACTIVITY_TIMEOUT_MS / 1_000} s and CUBE has none of it`
        : 'the watch ended before any file arrived; the PACS may still be sending (check with pacs status)';
      events.task?.(t, 'unconfirmed', 'retrying');
    }
  }
  return extraFiringErrors;
}
