/**
 * @file The joblet a line runs in, as a fact the line can read.
 *
 * A line ended with `&` runs as a joblet (`./joblets.js`): nobody is at its
 * console, and a question it asks waits until someone types `fg %N`. A verb
 * that can decide for itself what a person would otherwise be asked (how
 * long to wait on a silent PACS) reads here whether it runs in a joblet,
 * and does not ask when it does. A verb that cannot go on without an answer
 * (a password, a removal to confirm) asks as it would in front, and waits.
 *
 * Key components:
 * - jobletScope_run: runs work as a joblet's.
 * - jobletCurrent_get: the joblet the calling code runs in, or null.
 *
 * Typical usage:
 * ```ts
 * const detached: boolean = jobletCurrent_get() !== null;
 * ```
 *
 * Dependencies: Node.js `async_hooks` only.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The number of the joblet on this async path. */
const jobletScope: AsyncLocalStorage<number> = new AsyncLocalStorage<number>();

/**
 * Runs work as a joblet's: everything it awaits reads that joblet's number.
 *
 * @param number - The joblet's number, as `/proc/joblets/<N>` has it.
 * @param operation - The work.
 * @returns What the work returns.
 *
 * @example
 * ```ts
 * await jobletScope_run(1, async (): Promise<number | null> => jobletCurrent_get()); // 1
 * ```
 */
export async function jobletScope_run<T>(number: number, operation: () => Promise<T>): Promise<T> {
  return await jobletScope.run(number, operation);
}

/**
 * The joblet the calling code runs in.
 *
 * @returns Its number, or null for a line in front.
 *
 * @example
 * ```ts
 * jobletCurrent_get(); // null at a console's own line
 * ```
 */
export function jobletCurrent_get(): number | null {
  return jobletScope.getStore() ?? null;
}
