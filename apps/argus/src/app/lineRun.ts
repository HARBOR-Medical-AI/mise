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
 * - askOwner_find: the screen whose line raised a question.
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
 * an error or its exit status is not zero, declined when an answer carries
 * the `line.declined` model, and what the session said was wrong from the
 * error answers themselves.
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
  // Refused by an error answer, or by the line's own exit status where the daemon says it (a line may end
  // badly with no error answer); a daemon that says no status is read by its answers alone.
  const ok: boolean = refused.length === 0 && (outcome.exitCode ?? 0) === 0;
  // Why, in the session's own words for it: the errors an answer carries, or what it said on its error
  // channel, colour removed. Never what the line happened to print on the way.
  const why: string[] = refused.flatMap((envelope): string[] => (envelope.errors !== undefined && envelope.errors.length > 0
    ? envelope.errors.map((error): string => error.message)
    : (envelope.renderedErr ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n'))).map((line: string): string => line.trim()).filter((line: string): boolean => line !== '');
  if (!ok && why.length === 0) why.push(outcome.exitCode !== undefined && outcome.exitCode !== 0 ? `the line ended with status ${String(outcome.exitCode)}, and the session gave no reason` : 'the session refused it, and gave no reason');
  return { ok, declined: outcome.envelopes.some((envelope): boolean => envelope.model?.kind === LINE_DECLINED_MODEL_KIND), why };
}

/**
 * Something that runs lines of its own and can say whether a line is one of them.
 *
 * @example
 * ```ts
 * const owner: LineOwner = { line_owns: (id) => flight_owns(flight, id) };
 * ```
 */
export interface LineOwner {
  /** Whether the line of this id is one this owner sent and still waits on. */
  line_owns(id: string): boolean;
}

/**
 * Finds whose a question is among the screens that run lines of their own:
 * the one that sent the line that raised it, by the id the client gave that
 * line. Which screen is showing, or busy, does not enter into it: a
 * question raised by the VM controller's line is the VM controller's even
 * while another screen has a line of its own outstanding, and stays its own
 * while it is left and opened again.
 *
 * @param executeId - The id of the line that raised the question; undefined when the daemon did not say.
 * @param owners - The screens that run lines.
 * @returns The owner, or null when the line is none of theirs or is not known.
 *
 * @example
 * ```ts
 * askOwner_find(request.executeId, [scriptScreen, vmController])?.ask(request);
 * ```
 */
export function askOwner_find<Owner extends LineOwner>(executeId: string | undefined, owners: ReadonlyArray<Owner>): Owner | null {
  if (executeId === undefined) return null;
  return owners.find((owner: Owner): boolean => owner.line_owns(executeId)) ?? null;
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
