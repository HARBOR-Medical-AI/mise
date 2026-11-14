/**
 * @file Warm-up steps behind the prompt: those still running, and those that failed.
 *
 * A warm-up moved off the boot gate reports its failure afterwards, and a
 * boot readout has scrolled away by then. So a failure is held here until
 * a later attempt succeeds, and every surface reads it from the prompt
 * context: a message that vanishes is one nobody acts on.
 *
 * A step still running is held here too, from its start to its outcome: a
 * daemon listens before its warm-up ends, and a surface that attaches
 * meanwhile is told what the session is still warming.
 *
 * Kept free of imports so it can be unit tested; the engine graph cannot
 * be loaded under jest.
 *
 * @module
 */

/**
 * One warm-up step that failed and has not since succeeded.
 *
 * @property label - The boot-step label, as the readout named it.
 * @property message - What the failure said.
 */
export interface WarmupFailure {
  label: string;
  message: string;
}

/** Failures by label, so a later attempt replaces rather than repeats. */
const failures: Map<string, string> = new Map();

/** Labels of the steps still running, in the order they started. */
const pending: Set<string> = new Set();

/**
 * Records that a deferred warm-up step has started and not yet settled.
 *
 * @param label - The boot-step label.
 *
 * @example
 * warmupPending_note('Public');
 * warmupPending_list(); // ['Public']
 */
export function warmupPending_note(label: string): void {
  pending.add(label);
}

/**
 * Records that a deferred warm-up step has settled, whatever its outcome.
 *
 * @param label - The boot-step label.
 *
 * @example
 * warmupPending_clear('Public');
 */
export function warmupPending_clear(label: string): void {
  pending.delete(label);
}

/**
 * The steps still warming, in the order they started.
 *
 * @returns One label per step that has started and not yet settled.
 *
 * @example
 * warmupPending_list(); // ['Public', 'Queries'] while those two run
 */
export function warmupPending_list(): string[] {
  return Array.from(pending);
}

/**
 * Records that a deferred warm-up step failed.
 *
 * @param label - The boot-step label.
 * @param message - What the failure said.
 */
export function warmupFailure_note(label: string, message: string): void {
  failures.set(label, message);
}

/**
 * Records that a step succeeded, clearing any failure it was holding.
 *
 * @param label - The boot-step label.
 */
export function warmupFailure_clear(label: string): void {
  failures.delete(label);
}

/**
 * The failures still outstanding, in the order they were first recorded.
 *
 * @returns One entry per step that failed and has not since succeeded.
 */
export function warmupFailures_list(): WarmupFailure[] {
  return Array.from(failures, ([label, message]: [string, string]): WarmupFailure => ({ label, message }));
}

/** Forgets every recorded failure and running step (tests, and a session starting over). */
export function warmupFailures_reset(): void {
  failures.clear();
  pending.clear();
}
