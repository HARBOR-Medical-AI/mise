/**
 * @file A screen's clocks, held by name and stopped together.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ScreenTimers } from '../../src/features/script/timers.js';

describe('ScreenTimers', () => {
  beforeEach((): void => { jest.useFakeTimers(); });
  afterEach((): void => { jest.useRealTimers(); });

  it('a wait runs its act once, and is no longer running after', () => {
    const timers: ScreenTimers = new ScreenTimers();
    let ran: number = 0;
    timers.timeout_set('cost', 400, (): void => { ran++; });
    expect(timers.timer_runs('cost')).toBe(true);
    jest.advanceTimersByTime(399);
    expect(ran).toBe(0);
    jest.advanceTimersByTime(1);
    expect(ran).toBe(1);
    expect(timers.timer_runs('cost')).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a name waits for one thing at a time: set again, the earlier wait is gone and only the later act runs', () => {
    const timers: ScreenTimers = new ScreenTimers();
    const ran: string[] = [];
    timers.timeout_set('cost', 400, (): void => { ran.push('first'); });
    jest.advanceTimersByTime(300);
    timers.timeout_set('cost', 400, (): void => { ran.push('second'); });
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(400);
    expect(ran).toEqual(['second']);
  });

  it('a tick goes on until it is stopped, and asked for twice is one tick', () => {
    const timers: ScreenTimers = new ScreenTimers();
    let ticks: number = 0;
    timers.interval_set('run', 1000, (): void => { ticks++; });
    timers.interval_set('run', 1000, (): void => { ticks += 100; });
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(3000);
    expect(ticks).toBe(3);
    timers.timer_stop('run');
    jest.advanceTimersByTime(3000);
    expect(ticks).toBe(3);
    expect(timers.timer_runs('run')).toBe(false);
    // Stopping what is not running is nothing.
    timers.timer_stop('run');
    timers.timer_stop('never');
  });

  it('stopped together: every clock ends by one call, none of their acts runs, and nothing starts after', () => {
    const timers: ScreenTimers = new ScreenTimers();
    let ran: number = 0;
    timers.timeout_set('cost', 400, (): void => { ran++; });
    timers.timeout_set('lever', 400, (): void => { ran++; });
    timers.interval_set('run', 1000, (): void => { ran++; });
    expect(jest.getTimerCount()).toBe(3);
    timers.timers_stop();
    expect(jest.getTimerCount()).toBe(0);
    timers.timeout_set('cost', 400, (): void => { ran++; });
    timers.interval_set('run', 1000, (): void => { ran++; });
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(ran).toBe(0);
  });
});
