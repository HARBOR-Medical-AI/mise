/**
 * @file Who holds this chell's terminal while a session asks things of it.
 *
 * The terminal has one reader and one writer at a time: a question put to the person, a host command or editor
 * that runs on it, a program on the session's pty it is handed to, or a question of the session's own. Each takes
 * the terminal and gives it back; whoever comes next waits its turn, in order. A question put to the person does not
 * wait behind someone who already holds the terminal: it is refused, so nothing can answer it but the person, fresh.
 *
 * Key components:
 * - TerminalOwner: the holder, the queue, and the hand-back.
 *
 * Typical usage:
 * ```ts
 * const release: () => void = await owner.terminal_take('shell');
 * try { await run(); } finally { release(); }
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/** Who may hold the terminal. */
export type TerminalHolder = 'question' | 'shell' | 'edit' | 'pty' | 'prompt';

/**
 * The one holder of this chell's terminal, and those waiting for it.
 *
 * @example
 * ```ts
 * const owner: TerminalOwner = new TerminalOwner();
 * ```
 */
export class TerminalOwner {
  /** Who holds it now, or null. */
  private holder: TerminalHolder | null = null;
  /** Those waiting, in order. */
  private readonly waiting: Waiter[] = [];

  /**
   * Who holds the terminal now.
   *
   * @returns The holder, or null when it is free.
   *
   * @example
   * ```ts
   * if (owner.holder_get() === 'pty') refuse();
   * ```
   */
  public holder_get(): TerminalHolder | null {
    return this.holder;
  }

  /**
   * Takes the terminal, waiting for whoever holds it; resolves with the hand-back. The terminal passes straight to
   * the next in line when it is given back, so no one can take it between.
   *
   * @param who - Who takes it.
   * @param signal - Withdraws the wait (the connection closed): it then rejects and holds nothing.
   * @returns The call that gives it back (once).
   * @throws {Error} When withdrawn before it was had.
   *
   * @example
   * ```ts
   * const release: () => void = await owner.terminal_take('edit');
   * ```
   */
  public async terminal_take(who: TerminalHolder, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw new Error('withdrawn: the terminal was not taken');
    if (this.holder === null && this.waiting.length === 0) {
      this.holder = who;
      return this.handBack_make();
    }
    await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
      const waiter: Waiter = { who, turn_give: (): void => { resolve(); } };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', (): void => {
        const at: number = this.waiting.indexOf(waiter);
        if (at < 0) return;
        this.waiting.splice(at, 1);
        reject(new Error('withdrawn: the terminal was not taken'));
      }, { once: true });
    });
    return this.handBack_make();
  }

  /**
   * Takes the terminal at once if it is free and no one waits; else nothing.
   *
   * @param who - Who takes it.
   * @returns The hand-back, or null when it is held.
   *
   * @example
   * ```ts
   * const release: (() => void) | null = owner.terminal_tryTake('question');
   * ```
   */
  public terminal_tryTake(who: TerminalHolder): (() => void) | null {
    if (this.holder !== null || this.waiting.length > 0) return null;
    this.holder = who;
    return this.handBack_make();
  }

  /**
   * The once-only hand-back of the terminal: to the next in line (who holds it from that moment), else free.
   *
   * @returns The hand-back.
   */
  private handBack_make(): () => void {
    let given: boolean = false;
    return (): void => {
      if (given) return;
      given = true;
      const next: Waiter | undefined = this.waiting.shift();
      this.holder = next?.who ?? null;
      next?.turn_give();
    };
  }
}

/** One waiting for the terminal. */
interface Waiter {
  /** Who waits. */
  who: TerminalHolder;
  /** Lets it go on, holding the terminal. */
  turn_give: () => void;
}
