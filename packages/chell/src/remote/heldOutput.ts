/**
 * @file What a session says, and what this chell would note, while a question is put to the person.
 *
 * While a question is open the terminal is the question's: the session's messages (except a line's end and its
 * requests, which wait their own turn) and this chell's own notes are held, within a bound, and handled in order
 * once the last question closes. Past the bound, what needs an answer or ends something is answered at once; the
 * rest is dropped and said once afterwards. When the connection closes, nothing held is handled.
 *
 * Key components:
 * - HeldOutput: the hold, its bound, its flush.
 *
 * Typical usage:
 * ```ts
 * if (hold.message_take(payload, raw)) return;
 * ```
 *
 * Dependencies: chalk.
 *
 * @module
 */

import chalk from 'chalk';

/**
 * How a hold is told whether a question is open and hands back what it held.
 *
 * @example
 * ```ts
 * const options: HeldOutputOptions = { question_isOpen, message_handle, overflow_answer };
 * ```
 */
export interface HeldOutputOptions {
  /** Whether a question is open now. */
  question_isOpen: () => boolean;
  /** Handles one of the session's messages. */
  message_handle: (payload: Buffer) => void;
  /** Answers a message past the bound that cannot be dropped; false when it may be dropped. */
  overflow_answer: (raw: unknown) => boolean;
}

/**
 * The hold for one connection.
 *
 * @example
 * ```ts
 * const hold: HeldOutput = new HeldOutput({ question_isOpen, message_handle, overflow_answer });
 * ```
 */
export class HeldOutput {
  /** What is held, in order: the session's messages, and this chell's notes as text. */
  private readonly items: Array<Buffer | string> = [];
  /** How many bytes are held. */
  private bytes: number = 0;
  /** Whether something was dropped past the bound (said once afterwards). */
  private dropped: boolean = false;
  /** Whether the connection has closed: nothing more is held or shown. */
  private closed: boolean = false;

  /**
   * @param options - What the hold is told and hands back.
   */
  constructor(private readonly options: HeldOutputOptions) {}

  /**
   * Holds one of the session's messages while a question is open; past the bound it is answered or dropped.
   *
   * @param payload - The message.
   * @param raw - It, parsed.
   * @returns True when it was held, answered or dropped, so it is not handled now; false after the hold has closed.
   *
   * @example
   * ```ts
   * if (hold.message_take(payload, raw)) return;
   * ```
   */
  public message_take(payload: Buffer, raw: unknown): boolean {
    // Once the connection has closed nothing is held for later: what still arrives settles at once (a line's end
    // its waiting call, a request its refusal), and nothing held before is shown.
    if (this.closed || held_passes(raw) || !this.options.question_isOpen()) return false;
    if (!this.room_has(payload.length)) {
      // Past the bound: what needs an answer or ends something is answered now, never replayed late.
      if (!this.options.overflow_answer(raw)) this.dropped = true;
      return true;
    }
    this.items.push(payload);
    this.bytes += payload.length;
    return true;
  }

  /**
   * Shows one of this chell's notes: now, or after the open question, within the same bound; never once the
   * connection has closed.
   *
   * @param text - The note.
   *
   * @example
   * ```ts
   * hold.notice_show('[!] ignoring an invalid message');
   * ```
   */
  public notice_show(text: string): void {
    if (this.closed) return;
    if (!this.options.question_isOpen()) {
      console.error(text);
      return;
    }
    const bytes: number = Buffer.byteLength(text);
    if (!this.room_has(bytes)) {
      this.dropped = true;
      return;
    }
    this.items.push(text);
    this.bytes += bytes;
  }

  /**
   * Whether the hold has room for one more item of this size: within the bytes, and within the count (so empty items
   * cost something too).
   *
   * @param bytes - The item's size, encoded.
   * @returns True when it fits.
   */
  private room_has(bytes: number): boolean {
    return this.items.length < HELD_ITEMS_MAX && this.bytes + bytes <= HELD_BYTES_MAX;
  }

  /**
   * Handles, in order, what was held while the question was open.
   *
   * @example
   * ```ts
   * consent.idle_set((): void => { hold.items_flush(); });
   * ```
   */
  public items_flush(): void {
    const items: Array<Buffer | string> = this.items.splice(0);
    this.bytes = 0;
    for (const item of items) {
      // A flushed message may close the connection: nothing after it is shown. One may open a question: what
      // follows it is held again, in order (a message by message_take, a note by notice_show).
      if (this.closed) return;
      if (typeof item === 'string') this.notice_show(item);
      else this.options.message_handle(item);
    }
    // The note that some was dropped is itself held while a question has opened again.
    if (this.closed || this.options.question_isOpen()) return;
    if (this.dropped) {
      this.dropped = false;
      console.error(chalk.yellow('[!] some of the session\'s output while the question was open was more than this chell holds, and was not shown'));
    }
  }

  /**
   * The connection has closed: what was held is dropped unhandled, and nothing more is held or shown.
   *
   * @example
   * ```ts
   * hold.hold_close();
   * ```
   */
  public hold_close(): void {
    this.closed = true;
    this.items.length = 0;
    this.bytes = 0;
    this.dropped = false;
  }
}

/** The most bytes held while a question is open, encoded. */
const HELD_BYTES_MAX: number = 1024 * 1024;

/** The most items held while a question is open, whatever their size. */
const HELD_ITEMS_MAX: number = 4096;

/** Messages that are never held while a question is open: a line's end, requests (which queue their own), a program's end. */
const HELD_PASSES: ReadonlySet<string> = new Set(['result', 'error', 'complete', 'shell', 'pipe', 'edit', 'deliver', 'hostPtyExit']);

/** What is still handled once the connection is closing: what settles a waiting call, or answers a request (no). */
const CLOSED_SETTLES: ReadonlySet<string> = new Set(['result', 'error', 'complete', 'shell', 'pipe', 'edit', 'deliver', 'prompt', 'hostPtyStart', 'hostPtyExit']);

/**
 * Whether a message of the session's is still handled once its connection is closing: one that settles a call or
 * answers a request; nothing that would be shown.
 *
 * @param type - The message's type.
 * @returns True when it is still handled.
 *
 * @example
 * ```ts
 * if (closed && !closedMessage_settles(message.type)) return;
 * ```
 */
export function closedMessage_settles(type: string): boolean {
  return CLOSED_SETTLES.has(type);
}

/**
 * Whether a message of the session's goes through while a question is open.
 *
 * @param raw - The parsed message.
 * @returns True for a line's end, for requests, and for a program's end.
 */
function held_passes(raw: unknown): boolean {
  const type: unknown = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'type') : undefined;
  return typeof type === 'string' && HELD_PASSES.has(type);
}
