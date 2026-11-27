/**
 * @file The clocks a screen runs, held in one place and stopped together.
 *
 * A takeover screen waits on several things at once (a price asked a moment
 * after a lever moves, a standing read again, a run's one-second tick). Each
 * was a field of its own, in the screen and in the screen that extends it,
 * and leaving the screen had to remember every one. Here each is named, a
 * name runs one clock at a time, and `timers_stop` ends them all: a screen
 * that is left stops its clocks by one call, whoever started them.
 *
 * Key components:
 * - ScreenTimers: the holder.
 *
 * Typical usage:
 * ```ts
 * this.timers.timeout_set('cost', 400, () => this.cost_ask());
 * this.timers.timers_stop(); // on leaving
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/**
 * The clocks of one screen, by name.
 *
 * @example
 * ```ts
 * const timers: ScreenTimers = new ScreenTimers();
 * timers.interval_set('tick', 1000, () => redraw());
 * timers.timers_stop();
 * ```
 */
export class ScreenTimers {
  /** The clocks running, by name: each with how to stop it. */
  private readonly running: Map<string, () => void> = new Map();

  /** True once the screen has been left: nothing starts after that. */
  private stopped: boolean = false;

  /**
   * Runs something once, after a wait. A wait already running under the
   * name is replaced: the name waits for one thing at a time.
   *
   * @param name - The clock's name.
   * @param ms - The wait.
   * @param act - What runs when it is over.
   *
   * @example
   * ```ts
   * timers.timeout_set('cost', 400, () => price_ask());
   * ```
   */
  public timeout_set(name: string, ms: number, act: () => void): void {
    this.timer_stop(name);
    if (this.stopped) return;
    const handle: ReturnType<typeof setTimeout> = setTimeout((): void => {
      this.running.delete(name);
      act();
    }, ms);
    this.running.set(name, (): void => { clearTimeout(handle); });
  }

  /**
   * Runs something again and again. A tick already running under the name
   * goes on as it is.
   *
   * @param name - The clock's name.
   * @param ms - The time between ticks.
   * @param act - What runs at each.
   *
   * @example
   * ```ts
   * timers.interval_set('run', 1000, () => run_redraw());
   * ```
   */
  public interval_set(name: string, ms: number, act: () => void): void {
    if (this.stopped || this.running.has(name)) return;
    const handle: ReturnType<typeof setInterval> = setInterval(act, ms);
    this.running.set(name, (): void => { clearInterval(handle); });
  }

  /**
   * Stops one clock; nothing happens when it is not running.
   *
   * @param name - The clock's name.
   *
   * @example
   * ```ts
   * timers.timer_stop('run');
   * ```
   */
  public timer_stop(name: string): void {
    this.running.get(name)?.();
    this.running.delete(name);
  }

  /**
   * Whether a clock is running.
   *
   * @param name - The clock's name.
   * @returns True while it waits or ticks.
   *
   * @example
   * ```ts
   * if (!timers.timer_runs('cost')) price_ask();
   * ```
   */
  public timer_runs(name: string): boolean {
    return this.running.has(name);
  }

  /**
   * Stops every clock, and starts none after: the screen has been left.
   *
   * @example
   * ```ts
   * timers.timers_stop();
   * ```
   */
  public timers_stop(): void {
    this.stopped = true;
    for (const clock_stop of this.running.values()) clock_stop();
    this.running.clear();
  }
}
