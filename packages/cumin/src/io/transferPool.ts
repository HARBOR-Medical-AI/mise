/**
 * @file The transfer pool: files moved to or from CUBE several at a time,
 * at most a bounded number at once.
 *
 * A CUBE file costs a round trip before its first byte (about 0.14 s from
 * pangea to ekanite, 2026-11-14), so a folder of small files moved one at a
 * time is almost all waiting: 223 files took 31 s one at a time and about
 * 2.5 s eight at a time. The pool keeps up to `jobs` transfers in flight and
 * starts the next as each one ends. `download`, `upload` and `berth anchor`
 * all move their files through it.
 *
 * A file that fails is tried once more, then reported by the caller's
 * item; the rest continue. A cancel (the line's abort signal) starts nothing
 * new, does not retry, and hands each transfer in flight the same signal,
 * so a stream can stop where it is. Each attempt runs in an error-stack
 * scope of its own, so transfers side by side never drain each other's
 * notes; what an attempt leaves on its stack reaches the caller's stack
 * when the file is settled.
 *
 * Key components:
 * - transferPool_run: runs the work over the items, bounded, with one retry.
 * - transferJobs_check: whether a number is a number of jobs the pool takes.
 * - TRANSFER_JOBS_DEFAULT, TRANSFER_JOBS_MAX: the bounds every command shares.
 *
 * Typical usage:
 * ```ts
 * const result: TransferPoolResult<string, number> = await transferPool_run(
 *   paths, (path: string, signal: AbortSignal): Promise<number> => file_fetch(path, signal),
 *   { jobs: 8, signal: lineSignal, onSettled: (settled) => progress_write(settled) },
 * );
 * ```
 *
 * Dependencies: fond's error stack. No CUBE client: the work brings its own.
 *
 * @module
 */
import { errorStack, type StackMessage } from '@fnndsc/fond';

/** How many files move at once when the line and the session say nothing. */
export const TRANSFER_JOBS_DEFAULT: number = 8;

/** The most files that move at once. */
export const TRANSFER_JOBS_MAX: number = 32;

/** How many more times a failed file is tried. */
export const TRANSFER_RETRIES: number = 1;

/**
 * The work for one item: moves it, and answers what the caller keeps.
 *
 * @example
 * ```ts
 * const work: TransferWork<string, number> = async (path: string, signal: AbortSignal): Promise<number> => fetchBytes(path, signal);
 * ```
 */
export type TransferWork<T, R> = (item: T, signal: AbortSignal) => Promise<R>;

/**
 * One item settled: moved, or failed after its retry.
 *
 * @example
 * ```ts
 * const settled: TransferSettled<string, number> = { item: '/a', ok: true, value: 3, attempts: 1 };
 * ```
 */
export type TransferSettled<T, R> =
  | { readonly item: T; readonly ok: true; readonly value: R; readonly attempts: number }
  | { readonly item: T; readonly ok: false; readonly reason: string; readonly attempts: number };

/**
 * How the pool runs.
 *
 * @example
 * ```ts
 * const options: TransferPoolOptions<string, number> = { jobs: 8 };
 * ```
 */
export interface TransferPoolOptions<T, R> {
  /** How many items move at once: a whole number from 1 to {@link TRANSFER_JOBS_MAX}. */
  readonly jobs: number;
  /** The line's abort signal: once it fires nothing new starts and nothing is retried. */
  readonly signal?: AbortSignal;
  /** How many more times a failed item is tried; {@link TRANSFER_RETRIES} by default. */
  readonly retries?: number;
  /** Told each item as it settles, in the order they end. */
  readonly onSettled?: (settled: TransferSettled<T, R>) => void;
}

/**
 * One item that moved, and what its work answered.
 *
 * @example
 * ```ts
 * const done: TransferDone<string, number> = { item: '/a', value: 3 };
 * ```
 */
export interface TransferDone<T, R> {
  /** The item. */
  readonly item: T;
  /** What its work answered. */
  readonly value: R;
}

/**
 * One item that failed after its retry.
 *
 * @example
 * ```ts
 * const failed: TransferFailure<string> = { item: '/a', reason: 'CUBE answered 500', attempts: 2 };
 * ```
 */
export interface TransferFailure<T> {
  /** The item. */
  readonly item: T;
  /** Why its last attempt failed. */
  readonly reason: string;
  /** How many times it was tried. */
  readonly attempts: number;
}

/**
 * What the pool came to.
 *
 * @example
 * ```ts
 * const result: TransferPoolResult<string, number> = { done: [], failed: [], cancelled: [] };
 * ```
 */
export interface TransferPoolResult<T, R> {
  /** The items that moved, in the order they ended. */
  readonly done: TransferDone<T, R>[];
  /** The items that failed after their retry, in the order they ended. */
  readonly failed: TransferFailure<T>[];
  /** The items a cancel left unmoved: never started, or stopped in flight. Empty unless the signal fired. */
  readonly cancelled: T[];
}

/** One attempt's outcome, with the notes it left on its own stack. */
type AttemptOutcome<R> =
  | { readonly ok: true; readonly value: R; readonly notes: StackMessage[] }
  | { readonly ok: false; readonly reason: string; readonly notes: StackMessage[] };

/**
 * Whether a number is a number of jobs the pool takes, and why not.
 *
 * @param jobs - The number.
 * @returns Null when it is one, else the reason in a few words.
 *
 * @example
 * ```ts
 * transferJobs_check(8);  // null
 * transferJobs_check(40); // 'at most 32'
 * ```
 */
export function transferJobs_check(jobs: number): string | null {
  if (!Number.isInteger(jobs)) return 'not a whole number';
  if (jobs < 1) return 'at least 1';
  if (jobs > TRANSFER_JOBS_MAX) return `at most ${TRANSFER_JOBS_MAX}`;
  return null;
}

/**
 * An error's words.
 *
 * @param error - What was thrown.
 * @returns Its message, or its text.
 */
function reason_read(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one attempt in an error-stack scope of its own, and takes what it
 * left there.
 *
 * @param work - The work.
 * @param item - The item.
 * @param signal - The pool's signal.
 * @returns The attempt's outcome and its notes.
 */
async function attempt_run<T, R>(work: TransferWork<T, R>, item: T, signal: AbortSignal): Promise<AttemptOutcome<R>> {
  return errorStack.scope_run(async (): Promise<AttemptOutcome<R>> => {
    try {
      const value: R = await work(item, signal);
      return { ok: true, value, notes: errorStack.checkpoint_drain(0) };
    } catch (error: unknown) {
      return { ok: false, reason: reason_read(error), notes: errorStack.checkpoint_drain(0) };
    }
  });
}

/**
 * Runs the work over the items, at most `jobs` at once, each failed item
 * tried once more.
 *
 * Items start in their order; they end in whatever order they finish, and
 * `onSettled` hears them so. An item whose attempt fails while the signal
 * has fired counts as cancelled, not failed.
 *
 * @param items - What to move.
 * @param work - Moves one item; throws to fail it.
 * @param options - How many at once, the line's signal, the retries, the settle callback.
 * @returns What moved, what failed and what a cancel left.
 * @throws {RangeError} When `jobs` is not a whole number from 1 to {@link TRANSFER_JOBS_MAX}.
 *
 * @example
 * ```ts
 * const result: TransferPoolResult<number, number> = await transferPool_run(
 *   [1, 2, 3], async (n: number): Promise<number> => n * 2, { jobs: 2 },
 * );
 * result.done.length; // 3
 * ```
 */
export async function transferPool_run<T, R>(
  items: readonly T[],
  work: TransferWork<T, R>,
  options: TransferPoolOptions<T, R>,
): Promise<TransferPoolResult<T, R>> {
  const refusal: string | null = transferJobs_check(options.jobs);
  if (refusal !== null) throw new RangeError(`jobs: ${options.jobs}: ${refusal}`);
  const retries: number = options.retries ?? TRANSFER_RETRIES;
  const signal: AbortSignal = options.signal ?? new AbortController().signal;
  const result: TransferPoolResult<T, R> = { done: [], failed: [], cancelled: [] };
  let next: number = 0;

  const item_settle = async (item: T): Promise<void> => {
    let attempts: number = 0;
    for (;;) {
      attempts++;
      const outcome: AttemptOutcome<R> = await attempt_run(work, item, signal);
      const last: boolean = outcome.ok || signal.aborted || attempts > retries;
      // A retried attempt's notes are the retry's to say; only the last
      // attempt's reach the caller.
      if (last) errorStack.stack_restore(outcome.notes);
      if (outcome.ok) {
        result.done.push({ item, value: outcome.value });
        options.onSettled?.({ item, ok: true, value: outcome.value, attempts });
        return;
      }
      if (signal.aborted) {
        result.cancelled.push(item);
        return;
      }
      if (last) {
        result.failed.push({ item, reason: outcome.reason, attempts });
        options.onSettled?.({ item, ok: false, reason: outcome.reason, attempts });
        return;
      }
    }
  };

  const worker_run = async (): Promise<void> => {
    while (next < items.length) {
      const item: T = items[next++];
      if (signal.aborted) {
        result.cancelled.push(item);
        continue;
      }
      await item_settle(item);
    }
  };

  const workers: Promise<void>[] = [];
  for (let index: number = 0; index < Math.min(options.jobs, items.length); index++) workers.push(worker_run());
  await Promise.all(workers);
  return result;
}
