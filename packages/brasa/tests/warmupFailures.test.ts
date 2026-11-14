/**
 * @file Unit tests for the warm-up steps held behind the prompt: those still
 * running, from their start to their outcome, and those that failed.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  warmupFailure_clear, warmupFailure_note, warmupFailures_list, warmupFailures_reset,
  warmupPending_clear, warmupPending_list, warmupPending_note,
} from '../src/core/warmupFailures.js';

describe('warm-up steps behind the prompt', () => {
  beforeEach(() => { warmupFailures_reset(); });

  it('holds a running step from its start to its outcome, in the order the steps started', () => {
    warmupPending_note('Public');
    warmupPending_note('Queries');
    warmupPending_note('Public');
    expect(warmupPending_list()).toEqual(['Public', 'Queries']);
    warmupPending_clear('Public');
    expect(warmupPending_list()).toEqual(['Queries']);
    warmupPending_clear('Queries');
    expect(warmupPending_list()).toEqual([]);
  });

  it('keeps a failure apart from the running steps, and forgets both on a reset', () => {
    warmupPending_note('Queries');
    warmupFailure_note('Groups', 'membership service unavailable');
    expect(warmupFailures_list()).toEqual([{ label: 'Groups', message: 'membership service unavailable' }]);
    expect(warmupPending_list()).toEqual(['Queries']);
    warmupFailure_clear('Groups');
    expect(warmupFailures_list()).toEqual([]);
    warmupFailures_reset();
    expect(warmupPending_list()).toEqual([]);
  });
});
