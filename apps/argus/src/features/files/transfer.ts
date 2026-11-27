/**
 * @file Transfers: a row per download, from the press to the end, saying
 * what is happening (law a-download-says-how-far-it-has-got).
 *
 * A browser shows nothing of a download until its first byte, and CUBE can
 * take a minute to send one; a press that answers nothing for a minute
 * reads as a press that did nothing. The row stands the moment DOWNLOAD is
 * pressed and reads the daemon's own count (`/vfs?progress=<id>`): waiting
 * on CUBE and for how long, then bytes of the whole, the rate and the time
 * left, then done or why not. CANCEL asks the daemon to stop (`cancel=<id>`),
 * which the browser reports as a failed download.
 *
 * The rows stand in one stack at the foot of the screen, whichever pane,
 * preview or console line asked.
 *
 * @module
 */

/** Where a download stands, as the daemon reports it. */
export type TransferPhase = 'opening' | 'ready' | 'streaming' | 'done' | 'failed' | 'cancelled';

/** The daemon's report of one download. */
export interface TransferReport {
  phase: TransferPhase;
  bytes: number;
  size?: number;
  reason?: string;
  elapsedMs: number;
}

/** How often a row asks how far its download has got. */
export const TRANSFER_POLL_MS: number = 1000;

/** How long a row waits on one answer before it counts the session silent. */
export const TRANSFER_ASK_MS: number = 5000;

/** How many silent asks in a row before the row says it has lost touch. */
export const TRANSFER_SILENT_LIMIT: number = 3;

/** How long a finished row stands before it goes. */
export const TRANSFER_LINGER_MS: number = 20_000;

/** Bytes as an operator reads them. */
export function bytes_words(bytes: number): string {
  const units: string[] = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value: number = bytes;
  let unit: number = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** A span of time as m:ss, or h:mm:ss past an hour. */
export function duration_words(ms: number): string {
  const total: number = Math.max(0, Math.round(ms / 1000));
  const h: number = Math.floor(total / 3600);
  const m: number = Math.floor((total % 3600) / 60);
  const s: string = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The line a row reads for a report.
 *
 * @param report - The daemon's report.
 * @param rate - Bytes per second lately, when known.
 * @returns The words.
 */
export function transfer_words(report: TransferReport, rate: number | null): string {
  switch (report.phase) {
    case 'opening': return `WAITING FOR CUBE · ${duration_words(report.elapsedMs)}`;
    case 'ready': return 'CUBE ANSWERED · HANDING TO THE BROWSER';
    case 'streaming': {
      // The browser has the stream; CUBE has not sent its first byte yet.
      if (report.bytes === 0) return `WAITING FOR CUBE'S FIRST BYTE · ${duration_words(report.elapsedMs)}`;
      const parts: string[] = [report.size !== undefined ? `${bytes_words(report.bytes)} OF ${bytes_words(report.size)}` : bytes_words(report.bytes)];
      if (report.size !== undefined && report.size > 0) parts.push(`${Math.floor((100 * report.bytes) / report.size)}%`);
      if (rate !== null && rate > 0) {
        parts.push(`${bytes_words(rate)}/S`);
        if (report.size !== undefined) parts.push(`${duration_words((1000 * (report.size - report.bytes)) / rate)} LEFT`);
      }
      return parts.join(' · ');
    }
    case 'done': return `DONE · ${bytes_words(report.bytes)} IN ${duration_words(report.elapsedMs)}`;
    case 'failed': return `FAILED · ${report.reason ?? 'the session did not say why'}`;
    case 'cancelled': return 'CANCELLED';
  }
}

/** Whether a phase is an end. */
function phase_ended(phase: TransferPhase): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled';
}

/**
 * A URL on the byte route for one download's progress or its stop, built
 * from the download URL (which carries the session's token).
 *
 * @param downloadUrl - The byte route's download URL.
 * @param verb - `progress` or `cancel`.
 * @param id - The download.
 * @returns The URL.
 */
export function transferUrl_build(downloadUrl: string, verb: 'progress' | 'cancel', id: string): string {
  const url: URL = new URL(downloadUrl, window.location.href);
  const token: string | null = url.searchParams.get('token');
  url.search = '';
  url.searchParams.set(verb, id);
  if (token !== null) url.searchParams.set('token', token);
  return url.toString();
}

/** The stack the rows stand in, made once. */
function stack_get(): HTMLElement {
  let stack: HTMLElement | null = document.querySelector('.transfer-stack');
  if (stack === null) {
    stack = document.createElement('div');
    stack.className = 'transfer-stack';
    stack.setAttribute('role', 'status');
    document.body.appendChild(stack);
  }
  return stack;
}

/** One download's row, and how to drive it. */
export interface TransferRow {
  /** The row. */
  element: HTMLElement;
  /** Shows a report. */
  show(report: TransferReport): void;
  /** Ends the row as failed: the daemon's reason when it has one, else the page's. */
  fail(reason: string): void;
  /** Stops asking, and lets the row stand until dismissed. */
  stop(): void;
}

/**
 * Stands a row for a download and keeps it current until it ends.
 *
 * @param name - The file's name.
 * @param downloadUrl - The byte route's download URL (for progress and cancel).
 * @param id - The download's id.
 * @param fetcher - The fetch to use.
 * @returns The row.
 */
export function transfer_watch(name: string, downloadUrl: string, id: string, fetcher: typeof fetch = fetch): TransferRow {
  const element: HTMLElement = document.createElement('div');
  element.className = 'transfer-row';
  element.dataset['download'] = id;
  element.dataset['phase'] = 'opening';
  const label: HTMLElement = document.createElement('span');
  label.className = 'transfer-name';
  label.textContent = name;
  label.title = name;
  const bar: HTMLElement = document.createElement('span');
  bar.className = 'transfer-bar';
  const fill: HTMLElement = document.createElement('span');
  fill.className = 'transfer-fill';
  bar.appendChild(fill);
  const words: HTMLElement = document.createElement('span');
  words.className = 'transfer-words';
  words.textContent = 'ASKING THE SESSION';
  const action: HTMLButtonElement = document.createElement('button');
  action.type = 'button';
  action.className = 'transfer-action';
  action.textContent = 'CANCEL';
  element.append(label, bar, words, action);
  stack_get().appendChild(element);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let linger: ReturnType<typeof setTimeout> | null = null;
  let ended: boolean = false;
  let unknownSince: number | null = null;
  const samples: Array<{ at: number; bytes: number }> = [];

  const remove = (): void => element.remove();
  const end = (): void => {
    ended = true;
    if (timer !== null) clearTimeout(timer);
    action.textContent = 'CLOSE';
    action.title = 'dismiss this row';
    linger = setTimeout(remove, TRANSFER_LINGER_MS);
  };
  const rate_measure = (bytes: number): number | null => {
    const now: number = Date.now();
    samples.push({ at: now, bytes });
    while (samples.length > 1 && now - (samples[0]?.at ?? now) > 6000) samples.shift();
    const first = samples[0];
    if (first === undefined || now - first.at < 900) return null;
    return ((bytes - first.bytes) * 1000) / (now - first.at);
  };
  let cancelling: boolean = false;
  let silent: number = 0;
  const show = (report: TransferReport): void => {
    element.dataset['phase'] = report.phase;
    const said: string = transfer_words(report, report.phase === 'streaming' ? rate_measure(report.bytes) : null);
    words.textContent = cancelling && !phase_ended(report.phase) ? `CANCELLING · ${said}` : said;
    const share: number = report.phase === 'done' ? 1 : report.size !== undefined && report.size > 0 ? report.bytes / report.size : 0;
    fill.style.width = `${(100 * share).toFixed(1)}%`;
    if (phase_ended(report.phase)) end();
  };
  // One question to the daemon, never waited on past TRANSFER_ASK_MS: a
  // report, 'unknown' when the session knows no download by this id, or
  // null when it did not answer in time.
  const ask = async (verb: 'progress' | 'cancel'): Promise<TransferReport | 'unknown' | null> => {
    const controller: AbortController = new AbortController();
    const deadline: ReturnType<typeof setTimeout> = setTimeout((): void => controller.abort(), TRANSFER_ASK_MS);
    try {
      // A stop changes something, and is asked by POST; progress changes nothing, and is a GET.
      const answer: Response = await fetcher(transferUrl_build(downloadUrl, verb, id), { ...(verb === 'cancel' ? { method: 'POST' } : {}), credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!answer.ok) return 'unknown';
      return (await answer.json()) as TransferReport;
    } catch {
      return null;
    } finally {
      clearTimeout(deadline);
    }
  };
  const poll = async (): Promise<void> => {
    if (ended) return;
    const answer: TransferReport | 'unknown' | null = await ask('progress');
    if (ended) return;
    if (answer === null) {
      // A row that stops hearing says so, rather than standing still.
      silent += 1;
      if (silent >= TRANSFER_SILENT_LIMIT) words.textContent = 'LOST TOUCH WITH THE SESSION · STILL ASKING';
    } else if (answer === 'unknown') {
      silent = 0;
      // A session that does not count downloads (an older daemon), or one
      // the save has not reached yet: say the browser has it.
      unknownSince ??= Date.now();
      if (Date.now() - unknownSince > 5000) {
        element.dataset['phase'] = 'handed';
        words.textContent = 'HANDED TO THE BROWSER · SEE ITS DOWNLOADS';
        end();
        return;
      }
    } else {
      silent = 0;
      unknownSince = null;
      show(answer);
    }
    if (!ended) timer = setTimeout((): void => { void poll(); }, TRANSFER_POLL_MS);
  };
  action.addEventListener('click', (): void => {
    if (ended) {
      remove();
      return;
    }
    action.disabled = true;
    cancelling = true;
    words.textContent = 'CANCELLING';
    void ask('cancel').then((answer: TransferReport | 'unknown' | null): void => {
      action.disabled = false;
      if (ended) return;
      if (answer === null) {
        cancelling = false;
        words.textContent = 'THE CANCEL GOT NO ANSWER FROM THE SESSION · PRESS CANCEL AGAIN';
      } else if (answer === 'unknown') {
        cancelling = false;
        element.dataset['phase'] = 'handed';
        words.textContent = "THE SESSION DOES NOT KNOW THIS DOWNLOAD · CANCEL IT IN THE BROWSER'S DOWNLOADS";
        end();
      } else {
        show(answer);
      }
    });
  });
  void poll();
  return {
    element,
    show,
    fail: (reason: string): void => {
      if (ended) return;
      // The daemon's reason is CUBE's own; the page's stands when it has none.
      void fetcher(transferUrl_build(downloadUrl, 'progress', id), { credentials: 'same-origin', cache: 'no-store' })
        .then(async (answer: Response): Promise<TransferReport | null> => (answer.ok ? ((await answer.json()) as TransferReport) : null))
        .catch((): null => null)
        .then((report: TransferReport | null): void => {
          if (ended) return;
          show(report !== null && report.phase === 'failed' ? report : { phase: 'failed', bytes: 0, reason, elapsedMs: 0 });
        });
    },
    stop: (): void => {
      ended = true;
      if (timer !== null) clearTimeout(timer);
      if (linger !== null) clearTimeout(linger);
    },
  };
}
