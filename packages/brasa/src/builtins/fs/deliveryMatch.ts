/**
 * @file A delivery a line asked for, and whether a delivery that arrives is it.
 *
 * Kept apart from the reader (`deliveryIntent.ts`), which needs the
 * delivering commands' declarations: this half needs nothing, and a
 * surface's own code and tests can hold it without the engine.
 *
 * @module
 */

/** One delivery a line asks for. */
export interface DeliveryIntent {
  /** The command that asked. */
  readonly verb: string;
  /** The destination as the operator typed it, quoting removed; null when the command gave none. */
  readonly destination: string | null;
}

/**
 * Whether a delivery's destination is one a line asked for.
 *
 * @param intents - What the line in flight asked for.
 * @param destination - The destination a delivery names; undefined or empty when it names none.
 * @returns True when some intent has exactly that destination, or none where the delivery has none.
 */
export function deliveryIntent_matches(intents: ReadonlyArray<DeliveryIntent>, destination: string | undefined): boolean {
  const asked: string | null = destination === undefined || destination.length === 0 ? null : destination;
  return intents.some((intent: DeliveryIntent): boolean => intent.destination === asked);
}
