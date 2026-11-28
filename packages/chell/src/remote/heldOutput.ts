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
   * @returns True when it was held, answered or dropped, so it is not handled now.
   *
   * @example
   * ```ts
   * if (hold.message_take(payload, raw)) return;
   * ```
   */
  public message_take(payload: Buffer, raw: unknown): boolean {
    if (held_passes(raw) || !this.options.question_isOpen()) return false;
    if (this.bytes + payload.length > HELD_BYTES_MAX) {
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
    if (this.bytes + text.length > HELD_BYTES_MAX) {
      this.dropped = true;
      return;
    }
    this.items.push(text);
    this.bytes += text.length;
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
      if (typeof item === 'string') console.error(item);
      else this.options.message_handle(item);
    }
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

/** The most bytes held while a question is open. */
const HELD_BYTES_MAX: number = 1024 * 1024;

/** Messages that are never held while a question is open: a line's end, requests (which queue their own), a program's end. */
const HELD_PASSES: ReadonlySet<string> = new Set(['result', 'error', 'complete', 'shell', 'pipe', 'edit', 'deliver', 'hostPtyExit']);

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
