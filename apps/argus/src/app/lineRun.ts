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
 * - AskKeeper: a screen's questions kept as they arrived, through its leaving and returning.
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

/**
 * A question kept for a screen that is away: as the session put it, and how it is answered.
 *
 * @example
 * ```ts
 * keeper.held_keep({ request, resolve });
 * ```
 */
export interface HeldAsk {
  /** The question as it arrived, with the id of the line that raised it and what it is for and about. */
  readonly request: SurfaceAsk;
  /** Answers it; null abandons it. */
  readonly resolve: (value: string | null) => void;
}

/**
 * Keeps a screen's questions as they arrived: the one standing on it, and
 * the one held while it is away. What is kept is always the question itself
 * (its words, its kind, the id of the line that raised it, what it is for
 * and about), never a judgement of whose it was: when the screen opens
 * again the question is read against the line in flight then
 * (`askAbout_read`), so one whose line ended while the screen was away, or
 * whose line was sent again under a new id, is nobody's own any more.
 *
 * @example
 * ```ts
 * keeper.standing_note(request);                       // shown on the screen
 * keeper.standing_keep(fallback, standing.resolve);    // the screen is left
 * const waiting = keeper.held_take();                  // it opens again
 * if (waiting !== null) screen.ask_take(waiting.request.message, waiting.request.kind, askAbout_read(waiting.request, flight));
 * ```
 */
export class AskKeeper {
  /** The question now standing on the screen, as it arrived. */
  private standing: SurfaceAsk | null = null;
  /** The question held while the screen is away. */
  private held: HeldAsk | null = null;
  /** The bound on a held question. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param boundMs - How long a question is held before it is abandoned, so a forgotten screen never holds the session.
   */
  public constructor(private readonly boundMs: number) {}

  /**
   * Notes the question a screen has just been given to show. The newest
   * question wins: one held for the screen from before is abandoned.
   *
   * @param request - The question, as it arrived.
   *
   * @example
   * ```ts
   * keeper.standing_note(request);
   * ```
   */
  public standing_note(request: SurfaceAsk): void {
    // The newest question is the one that stands. One still held from before (the screen was opening when
    // this arrived) is retired here, with its bound: it is not handed over afterwards to push this one off.
    if (this.held !== null && this.held.request !== request) this.held_retire();
    this.standing = request;
  }

  /** Abandons the held question and its bound. */
  private held_retire(): void {
    const one: HeldAsk | null = this.held;
    this.held = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    one?.resolve(null);
  }

  /**
   * Forgets a question once it is answered, if it is still the one standing.
   *
   * @param request - The question that was answered.
   *
   * @example
   * ```ts
   * void screen.ask_take(…).finally(() => keeper.standing_clear(request));
   * ```
   */
  public standing_clear(request: SurfaceAsk): void {
    if (this.standing === request) this.standing = null;
  }

  /**
   * Holds the question that stands on a screen being left: the question as
   * it arrived when that is known, else what the screen shows of it.
   *
   * @param shown - The question as the screen shows it, for a screen given one this keeper never saw.
   * @param resolve - How it is answered.
   *
   * @example
   * ```ts
   * keeper.standing_keep({ message: standing.message, kind: standing.kind }, standing.resolve);
   * ```
   */
  public standing_keep(shown: SurfaceAsk, resolve: (value: string | null) => void): void {
    const request: SurfaceAsk = this.standing ?? shown;
    this.standing = null;
    this.held_keep({ request, resolve });
  }

  /**
   * Holds a question for the screen when it opens again; one already held is
   * abandoned, and this one is too if nobody comes for it within the bound.
   *
   * @param one - The question and how it is answered.
   *
   * @example
   * ```ts
   * keeper.held_keep({ request, resolve });
   * ```
   */
  public held_keep(one: HeldAsk): void {
    this.held_retire();
    this.held = one;
    this.timer = setTimeout((): void => { if (this.held === one) { this.held = null; one.resolve(null); } }, this.boundMs);
  }

  /**
   * Hands the held question to the screen that has opened, which shows it
   * and so has it standing again.
   *
   * @returns The question, or null when none is held.
   *
   * @example
   * ```ts
   * const waiting: HeldAsk | null = keeper.held_take();
   * ```
   */
  public held_take(): HeldAsk | null {
    const one: HeldAsk | null = this.held;
    this.held = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (one !== null) this.standing = one.request;
    return one;
  }
}
