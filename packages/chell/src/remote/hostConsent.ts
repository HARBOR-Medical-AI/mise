/**
 * @file The person's word for what a session asks this machine to run beyond what a line asked for.
 *
 * A request no grant covers (a script's `!`, a step after `&&`, a pipeline chell could not route) is not refused
 * silently where the person could say yes, and never run silently: it is put to them on this chell's own terminal,
 * with exactly what would run, quoted and with every control and direction character made visible. They answer
 * once (`y`), for the rest of the line and that kind of request (`l`), refuse the rest of the line (`r`), or let the
 * session run anything it asks on this machine until it disconnects (`allow all`, typed in full; or
 * `--allow-host-requests` at the start). Anything else is No; three No answers on one line refuse its rest. Where
 * no one can be asked (no terminal) the request is refused, as it was.
 *
 * Questions are asked one at a time, in the order they came (a bounded queue); a line's result, error or cancel,
 * or the connection's close, answers its open and queued questions No and forgets its `l`.
 *
 * Key components:
 * - HostConsent: the questions, the answers remembered, and their expiry.
 * - consentText_quote, consentQuestion_render, consentAnswer_read: what is shown, and what an answer means.
 *
 * Typical usage:
 * ```ts
 * const consent: HostConsent = new HostConsent(ask, false);
 * if (await consent.request_decide({ lineId, verified: true, kind: 'shell', action: 'run the host command "ls"' })) run();
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

import type { TerminalOwner } from './terminalOwner.js';

/** What kind of thing a request asks this machine to do. */
export type ConsentKind = 'shell' | 'pipe' | 'edit' | 'deliver' | 'pty';

/** How the person answered. */
export type ConsentAnswer = 'once' | 'line' | 'all' | 'refuse-line' | 'no';

/** Asks the person one question on this chell's terminal and returns the line they typed; aborted, it rejects. */
export type ConsentAsk = (question: string, signal: AbortSignal) => Promise<string>;

/**
 * One request put to the person.
 *
 * @example
 * ```ts
 * const asked: ConsentRequest = { lineId: '3', verified: true, kind: 'shell', action: 'run the host command "ls"' };
 * ```
 */
export interface ConsentRequest {
  /** The line the session says asks, by this chell's id; absent from an older daemon. */
  lineId: string | undefined;
  /** Whether that id is a line of this chell pending on this connection (a legacy request is never verified). */
  verified: boolean;
  /** What kind of request. */
  kind: ConsentKind;
  /** What would happen, in words, every untrusted part already quoted with `consentText_quote`. */
  action: string;
  /**
   * What `l` for this request covers besides its kind: for a delivery, its destination and source root, so another
   * destination or root is asked again. Absent: any request of the kind.
   */
  scope?: string;
  /** Only `y` is offered and read: what `l` would cover cannot be told from this request (a file whose source is unbound). */
  onceOnly?: boolean;
}

/** What is known of one line while it runs. */
interface LineConsent {
  /** The line as this chell sent it. */
  text: string;
  /** Kinds the person allowed for the rest of the line: all of the kind, or only the scopes named. */
  kinds: Map<ConsentKind, true | Set<string>>;
  /** Whether the person refused the rest of the line. */
  refused: boolean;
  /** How many times they said No on this line. */
  noes: number;
}

/** A question waiting its turn, or open. */
interface Pending {
  /** The line it is for. */
  lineId: string | undefined;
  /** Stops it: answered No. */
  abort: AbortController;
}

/** How many questions may wait behind the open one. */
const QUEUE_MAX: number = 8;

/** How many No answers on one line refuse its rest. */
const NOES_MAX: number = 3;

/**
 * Untrusted text as a question shows it: in double quotes, a backslash and a quote escaped, and every character
 * that could move the cursor, recolour, erase or reorder what the person reads (C0 controls, DEL, C1 controls,
 * Unicode format characters such as bidi overrides, isolates, zero-width joiners and tags) shown as `\u{hex}` by its
 * code point. A literal `\u001b` typed in the text and an escape character never read the same.
 *
 * @param text - Untrusted text.
 * @returns It, quoted, safe to show.
 *
 * @example
 * ```ts
 * consentText_quote('ls\u001b[2J'); // '"ls\\u{1b}[2J"'
 * ```
 */
export function consentText_quote(text: string): string {
  const shown: string = text.replace(/[\\"]|[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, (one: string): string => {
    if (one === '\\' || one === '"') return `\\${one}`;
    return `\\u{${(one.codePointAt(0) ?? 0).toString(16)}}`;
  });
  return `"${shown}"`;
}

/**
 * The question shown: what would run, in full (never cut), the line it is for, and the answers offered.
 *
 * @param asked - The request.
 * @param line - The line this chell sent, if the request names one of its lines.
 * @returns The question.
 *
 * @example
 * ```ts
 * consentQuestion_render(asked, 'play build.sh');
 * ```
 */
export function consentQuestion_render(asked: ConsentRequest, line: string | undefined): string {
  const during: string = !asked.verified
    ? `for a request that names no line (the session is older than this chell)${line !== undefined ? `, while running ${consentText_quote(line)}` : ''}`
    : `while running ${consentText_quote(line ?? '')}`;
  const offers: string[] = asked.verified
    ? [
        'y = yes, this once',
        ...(asked.onceOnly === true ? [] : [`l = yes, and any further ${asked.kind} request of this line${asked.scope !== undefined ? ' to the same folder here, from inside the same source' : ', whatever it runs'}`]),
        'r = no, and refuse the rest of this line',
        'allow all = let this session run anything it asks on this machine until it disconnects',
        'anything else = no',
      ]
    : ['y = yes, this once', 'anything else = no'];
  // Drawn plain whatever the session's output left the terminal in (concealed, recoloured, another character set).
  return `${TERMINAL_PLAIN}\nThe session asks this machine to ${asked.action}\n  ${during}.\n  ${offers.join('\n  ')}\nAllow? `;
}

/**
 * Puts the terminal's text back to plain, whatever the session's output left it in: the colour palette and the
 * default foreground and background colours reset (OSC 104, 110, 111: a session could have made them one colour),
 * reverse video off (DECSCNM), attributes off (SGR 0, which then draws in those defaults), and the ASCII character
 * set designated and shifted in.
 */
export const TERMINAL_PLAIN: string = '\u001b]104\u0007\u001b]110\u0007\u001b]111\u0007\u001b[?5l\u001b[0m\u001b(B\u000f';

/**
 * What an answer means: only `y`, `l`, `r` and `allow all` (trimmed, lower case) mean anything, and `l` and
 * `allow all` only for a verified request; anything else is No.
 *
 * @param typed - The line typed.
 * @param verified - Whether the request names a pending line of this chell.
 * @returns The answer.
 *
 * @example
 * ```ts
 * consentAnswer_read(' Y ', true); // 'once'
 * ```
 */
export function consentAnswer_read(typed: string, verified: boolean): ConsentAnswer {
  const said: string = typed.trim().toLowerCase();
  if (said === 'y') return 'once';
  if (!verified) return 'no';
  if (said === 'l') return 'line';
  if (said === 'r') return 'refuse-line';
  if (said === 'allow all') return 'all';
  return 'no';
}

/**
 * The person's word on requests no grant covers, for one connection.
 *
 * @example
 * ```ts
 * const consent: HostConsent = new HostConsent(ask, false);
 * ```
 */
export class HostConsent {
  /** What is known of each line of this chell while it runs. */
  private readonly lines: Map<string, LineConsent> = new Map();
  /** The open question and those waiting, in order. */
  private readonly pending: Pending[] = [];
  /** The question being asked now, if any. */
  private turn: Promise<void> = Promise.resolve();
  /** Whether the session may run anything it asks until it disconnects. */
  private allowedAll: boolean;
  /** Called when the last question closes, so held output is shown. */
  private onIdle: (() => void) | null = null;

  /**
   * @param ask - Asks on this chell's terminal; null where there is none (then nothing is asked).
   * @param allowAll - `--allow-host-requests`: the session may run anything it asks until it disconnects.
   * @param owner - Who holds this chell's terminal: a question is put only when it is free.
   */
  constructor(private readonly ask: ConsentAsk | null, allowAll: boolean, private readonly owner: TerminalOwner) {
    this.allowedAll = allowAll;
  }

  /**
   * Waits until no question is open or waiting, so what the session said meanwhile is shown after it.
   *
   * @returns When the last question has closed.
   *
   * @example
   * ```ts
   * await consent.idle_wait();
   * ```
   */
  public async idle_wait(): Promise<void> {
    while (this.pending.length > 0) await this.turn;
  }

  /**
   * Whether the session may run anything it asks on this machine until it disconnects.
   *
   * @returns True under `--allow-host-requests` or after `allow all`.
   *
   * @example
   * ```ts
   * if (consent.all_isAllowed()) say('this session may run anything it asks here');
   * ```
   */
  public all_isAllowed(): boolean {
    return this.allowedAll;
  }

  /**
   * Whether a question is open or waiting: the terminal is the question's, and the session's output waits.
   *
   * @returns True while one is.
   *
   * @example
   * ```ts
   * if (consent.question_isOpen()) hold(message);
   * ```
   */
  public question_isOpen(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Sets what to call when the last question closes.
   *
   * @param onIdle - The call, or null.
   *
   * @example
   * ```ts
   * consent.idle_set((): void => { held_flush(); });
   * ```
   */
  public idle_set(onIdle: (() => void) | null): void {
    this.onIdle = onIdle;
  }

  /**
   * Opens a line: its text is shown in its questions.
   *
   * @param lineId - This chell's id for the line.
   * @param text - The line as sent.
   *
   * @example
   * ```ts
   * consent.line_open('3', 'play build.sh');
   * ```
   */
  public line_open(lineId: string, text: string): void {
    this.lines.set(lineId, { text, kinds: new Map(), refused: false, noes: 0 });
  }

  /**
   * Closes a line: its open and waiting questions are answered No, and what was said for it is forgotten.
   *
   * @param lineId - This chell's id for the line.
   *
   * @example
   * ```ts
   * consent.line_close('3');
   * ```
   */
  public line_close(lineId: string): void {
    this.lines.delete(lineId);
    for (const one of this.pending) if (one.lineId === lineId) one.abort.abort();
  }

  /**
   * The connection closed: every question is answered No, and `allow all` is gone with it.
   *
   * @example
   * ```ts
   * consent.all_close();
   * ```
   */
  public all_close(): void {
    this.lines.clear();
    for (const one of this.pending) one.abort.abort();
    this.allowedAll = false;
  }

  /**
   * Decides a request no grant covers: allowed when the person allowed it (now, for the line, or for the
   * connection), else asked where they can be, one question at a time; refused otherwise.
   *
   * @param asked - The request.
   * @returns True when it may run.
   *
   * @example
   * ```ts
   * if (!(await consent.request_decide(asked))) refuse();
   * ```
   */
  public async request_decide(asked: ConsentRequest): Promise<boolean> {
    // Every request asked about is bound to a line of this chell that is running (a legacy one to the sole line).
    const line: LineConsent | undefined = asked.lineId !== undefined ? this.lines.get(asked.lineId) : undefined;
    if (line === undefined) return false;
    if (asked.verified && this.allowedAll) return true;
    if (line.refused) return false;
    if (asked.verified && scope_allows(line, asked)) return true;
    if (this.ask === null || this.pending.length > QUEUE_MAX) return false;
    const mine: Pending = { lineId: asked.lineId, abort: new AbortController() };
    this.pending.push(mine);
    const waited: Promise<void> = this.turn;
    let turn_release: () => void = (): void => undefined;
    this.turn = new Promise<void>((resolve: () => void): void => { turn_release = resolve; });
    try {
      await waited;
      return await this.question_put(asked, mine);
    } finally {
      this.pending.splice(this.pending.indexOf(mine), 1);
      turn_release();
      if (this.pending.length === 0) this.onIdle?.();
    }
  }

  /**
   * Puts one request to the person, when it is still live, and applies the answer.
   *
   * @param asked - The request.
   * @param mine - Its place in the queue.
   * @returns True when it may run.
   */
  private async question_put(asked: ConsentRequest, mine: Pending): Promise<boolean> {
    // Rechecked now it is this request's turn: the line may have ended, or an earlier answer decided it.
    const settled: boolean | null = this.request_settled(asked, mine);
    if (settled !== null) return settled;
    const line: LineConsent | undefined = asked.lineId !== undefined ? this.lines.get(asked.lineId) : undefined;
    // The terminal is the question's alone, or the question is not put: nothing else may answer it.
    const terminal_release: (() => void) | null = this.owner.terminal_tryTake('question');
    if (terminal_release === null) return false;
    let typed: string;
    try {
      typed = await (this.ask as ConsentAsk)(consentQuestion_render(asked, line?.text), mine.abort.signal);
    } catch {
      return false;
    } finally {
      terminal_release();
    }
    // An answer that arrives after the line ended answers nothing.
    if (this.request_isOver(asked, mine)) return false;
    const answer: ConsentAnswer = consentAnswer_read(typed, asked.verified);
    // `l` is not offered for a request it could not be bound to; typed anyway, it is a No.
    return this.answer_apply(answer === 'line' && asked.onceOnly === true ? 'no' : answer, asked, line);
  }

  /**
   * Whether a request is already decided without a question: over (withdrawn, or its line ended), or allowed or
   * refused by an earlier answer.
   *
   * @param asked - The request.
   * @param mine - Its place in the queue.
   * @returns The decision, or null when it must be asked.
   */
  private request_settled(asked: ConsentRequest, mine: Pending): boolean | null {
    if (this.request_isOver(asked, mine)) return false;
    if (asked.verified && this.allowedAll) return true;
    const line: LineConsent | undefined = asked.lineId !== undefined ? this.lines.get(asked.lineId) : undefined;
    if (line === undefined) return null;
    if (line.refused) return false;
    return asked.verified && scope_allows(line, asked) ? true : null;
  }

  /**
   * Whether a request no longer wants an answer: it was withdrawn, or the line it names has ended.
   *
   * @param asked - The request.
   * @param mine - Its place in the queue.
   * @returns True when it is over.
   */
  private request_isOver(asked: ConsentRequest, mine: Pending): boolean {
    return mine.abort.signal.aborted || !this.lines.has(asked.lineId ?? '');
  }

  /**
   * Applies an answer to the line and the connection.
   *
   * @param answer - What was answered.
   * @param asked - The request.
   * @param line - Its line, when it names one.
   * @returns True when the request may run.
   */
  private answer_apply(answer: ConsentAnswer, asked: ConsentRequest, line: LineConsent | undefined): boolean {
    if (answer === 'once') return true;
    if (answer === 'line' && line !== undefined) {
      scope_allow(line, asked);
      return true;
    }
    if (answer === 'all') {
      this.allowedAll = true;
      return true;
    }
    if (line !== undefined) {
      line.noes += 1;
      if (answer === 'refuse-line' || line.noes >= NOES_MAX) this.line_refuse(line, asked.lineId);
    }
    return false;
  }

  /**
   * Refuses the rest of a line: its waiting questions are answered No at once.
   *
   * @param line - The line.
   * @param lineId - Its id.
   */
  private line_refuse(line: LineConsent, lineId: string | undefined): void {
    line.refused = true;
    for (const one of this.pending) if (one.lineId === lineId) one.abort.abort();
  }
}

/**
 * Whether `l` already given on a line covers a request: its kind, and its scope when the request has one.
 *
 * @param line - The line.
 * @param asked - The request.
 * @returns True when it does.
 */
function scope_allows(line: LineConsent, asked: ConsentRequest): boolean {
  const allowed: true | Set<string> | undefined = line.kinds.get(asked.kind);
  if (allowed === undefined) return false;
  return allowed === true || (asked.scope !== undefined && allowed.has(asked.scope));
}

/**
 * Records `l` for a request: its whole kind, or (with a scope) that scope of it.
 *
 * @param line - The line.
 * @param asked - The request.
 */
function scope_allow(line: LineConsent, asked: ConsentRequest): void {
  if (asked.scope === undefined) {
    line.kinds.set(asked.kind, true);
    return;
  }
  const allowed: true | Set<string> | undefined = line.kinds.get(asked.kind);
  if (allowed === true) return;
  line.kinds.set(asked.kind, new Set([...(allowed ?? []), asked.scope]));
}
