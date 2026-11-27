/**
 * @file What a screen's host reads off the session for the screen: how a line
 * it ran came to its end, and whose a question is.
 *
 * Both are read from what the session sent as typed state: an envelope's
 * status and model, a question's line id, purpose and subject. Nothing here
 * reads the words a line printed.
 *
 * Key components:
 * - runEnd_read: an outcome's envelopes as a RunEnd.
 * - askAbout_read: a question as an AskAbout, against the line in flight.
 * - flight_owns: whether an event is of the line in flight.
 *
 * Typical usage:
 * ```ts
 * const end: RunEnd = runEnd_read(await client.line_execute(line, { operator: true, sent }));
 * ```
 *
 * Dependencies: the wire's `line.declined` model kind.
 *
 * @module
 */

import { LINE_DECLINED_MODEL_KIND } from '@fnndsc/menu';

import type { ExecuteOutcome, SurfaceAsk } from '../calypso/client.js';
import type { AskAbout, RunEnd } from '../features/script/model.js';

/**
 * A line a screen sent and is waiting on: the id the client gave it, and its text.
 *
 * @example
 * ```ts
 * const flight: LineInFlight = { id: 'argus-7', line: 'vm build store' };
 * ```
 */
export interface LineInFlight {
  /** The id the client gave the line. */
  readonly id: string;
  /** The line. */
  readonly line: string;
}

/**
 * Reads how a line ended from what it returned: refused when any answer is
 * an error, declined when one carries the `line.declined` model, and what
 * the session said was wrong from the error answers themselves.
 *
 * @param outcome - What the line returned.
 * @returns How it ended.
 *
 * @example
 * ```ts
 * runEnd_read({ envelopes: [{ status: 'ok', rendered: '', model: { kind: 'line.declined', data: {} } }], liveChannels: new Set() }).declined; // true
 * ```
 */
export function runEnd_read(outcome: ExecuteOutcome): RunEnd {
  const refused = outcome.envelopes.filter((envelope): boolean => envelope.status === 'error');
  return {
    ok: refused.length === 0,
    declined: outcome.envelopes.some((envelope): boolean => envelope.model?.kind === LINE_DECLINED_MODEL_KIND),
    // The session's own words for a refusal, colour removed, a line each.
    why: refused.flatMap((envelope): string[] => (envelope.renderedErr ?? envelope.rendered ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')).map((line: string): string => line.trim()).filter((line: string): boolean => line !== ''),
  };
}

/**
 * Whether something the session sent for a line (an event of it) is of the
 * line a screen has in flight: by the id the client gave that line. Nothing
 * is, once the line has ended, or for another line on the same surface.
 *
 * @param flight - The line the screen has in flight, or null.
 * @param id - The id of the line the thing was sent for.
 * @returns True when it is that line's.
 *
 * @example
 * ```ts
 * flight_owns({ id: 'argus-7', line: 'vm build store' }, 'argus-8'); // false
 * ```
 */
export function flight_owns(flight: LineInFlight | null, id: string): boolean {
  return flight !== null && flight.id === id;
}

/**
 * Reads whose a question is: the screen's own when the line that raised it
 * is the one the screen sent and is waiting on, by the ids the client gave;
 * and what the command says the question is for and about.
 *
 * @param request - The question as it arrived.
 * @param flight - The line the screen has in flight, or null.
 * @returns What is known of the question beyond its words.
 *
 * @example
 * ```ts
 * askAbout_read({ message: '…', kind: 'confirm', executeId: 'argus-7', purpose: 'stratus.vm.build', subject: { vm: 'store' } }, { id: 'argus-7', line: 'vm build store' }).mine; // true
 * ```
 */
export function askAbout_read(request: SurfaceAsk, flight: LineInFlight | null): AskAbout {
  const mine: boolean = request.executeId !== undefined && flight_owns(flight, request.executeId);
  return { mine, line: mine && flight !== null ? flight.line : null, purpose: request.purpose ?? null, subject: request.subject ?? {} };
}
