/**
 * @file A pause that can be cut short: whichever ends it leaves nothing on
 * the signal.
 */
import { describe, it, expect } from '@jest/globals';
import { getEventListeners } from 'node:events';
import { pause } from '../src/vm/remote.js';

describe('pause', () => {
  it('leaves no listener on the signal when its time runs out, however often it is called on one signal', async () => {
    const controller: AbortController = new AbortController();
    // The callers loop on one signal for a whole build: eighteen times at the bastion, five per line.
    for (let round: number = 0; round < 25; round++) await pause(1, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('ends at once when the signal aborts, and leaves no listener then either', async () => {
    const controller: AbortController = new AbortController();
    const began: number = Date.now();
    const waiting: Promise<void> = pause(60_000, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort();
    await waiting;
    expect(Date.now() - began).toBeLessThan(1000);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not wait on a signal already aborted, or for no time', async () => {
    const controller: AbortController = new AbortController();
    controller.abort();
    await pause(60_000, controller.signal);
    const live: AbortController = new AbortController();
    await pause(0, live.signal);
    expect(getEventListeners(live.signal, 'abort')).toHaveLength(0);
  });
});
