/**
 * @file What a screen's host reads off the session: how a line ended, and
 * whose a question is, from typed state alone.
 */
import { describe, it, expect } from '@jest/globals';
import type { ExecuteOutcome } from '../../src/calypso/client.js';
import type { VmStepEvent } from '@fnndsc/menu';
import { askAbout_read, flight_owns, runEnd_read, type LineInFlight } from '../../src/app/lineRun.js';
import { buildRun_start, buildRun_step, type BuildRun } from '../../src/features/vm/run.js';

/** An outcome of the given envelopes. */
function outcome_make(envelopes: ExecuteOutcome['envelopes']): ExecuteOutcome {
  return { envelopes, liveChannels: new Set() };
}

describe('how a line ended', () => {
  it('is done when no answer is an error, whatever was printed', () => {
    expect(runEnd_read(outcome_make([{ status: 'ok', rendered: 'error: FAILED, stopped, n\n' }]))).toEqual({ ok: true, declined: false, why: [] });
  });

  it('is declined by the model the session sends for a NO, never by an answer typed or a word printed', () => {
    expect(runEnd_read(outcome_make([{ status: 'ok', rendered: 'all went well\n', model: { kind: 'line.declined', data: { line: 'build' } } }]))).toEqual({ ok: true, declined: true, why: [] });
    expect(runEnd_read(outcome_make([{ status: 'ok', rendered: 'stopped before the apply; nothing changed\n' }])).declined).toBe(false);
  });

  it('is refused by an error answer, and says why in the session\'s own words, colour removed', () => {
    const end = runEnd_read(outcome_make([{ status: 'ok', rendered: 'planned\n' }, { status: 'error', rendered: '', renderedErr: '\u001b[31mvm build: store: the plan reads a new machine\u001b[39m\n' }]));
    expect(end).toEqual({ ok: false, declined: false, why: ['vm build: store: the plan reads a new machine'] });
  });
});

describe('whose a question is', () => {
  const flight = { id: 'argus-7', line: 'vm build store' };

  it('is the screen\'s own when the line that raised it is the one in flight, by the id the client gave it', () => {
    expect(askAbout_read({ message: 'reworded entirely', kind: 'confirm', executeId: 'argus-7', purpose: 'stratus.vm.build', subject: { vm: 'store' } }, flight))
      .toEqual({ mine: true, line: 'vm build store', purpose: 'stratus.vm.build', subject: { vm: 'store' } });
  });

  it('is not, for another line on the same surface, however alike its words, purpose and subject', () => {
    const other = askAbout_read({ message: 'vm build store: …', kind: 'confirm', executeId: 'argus-8', purpose: 'stratus.vm.build', subject: { vm: 'store' } }, flight);
    expect(other.mine).toBe(false);
    expect(other.line).toBeNull();
  });

  it('is not, when no line is in flight, or the daemon did not say which line asked', () => {
    expect(askAbout_read({ message: 'm', kind: 'secret', executeId: 'argus-7' }, null).mine).toBe(false);
    expect(askAbout_read({ message: 'vm build store: Continue? [y/N]', kind: 'confirm' }, flight)).toEqual({ mine: false, line: null, purpose: null, subject: {} });
  });
});

describe('two builds asked from one surface', () => {
  /** Routes an event as the VM controller does: to the run of the line in flight, when it is that line's. */
  function routed(run: BuildRun, flight: LineInFlight | null, id: string, step: VmStepEvent): BuildRun {
    return flight_owns(flight, id) ? buildRun_step(run, step) : run;
  }

  it('a step of the other line moves nothing here, though it names the same machine and step; this line\'s own does', () => {
    const flight: LineInFlight = { id: 'argus-7', line: 'vm build store' };
    const run: BuildRun = buildRun_start('store', '', 0);
    const begun: VmStepEvent = { vm: 'store', step: 'apply-machine', state: 'begun' };
    expect(routed(run, flight, 'argus-8', begun)).toBe(run);
    expect(routed(run, flight, 'argus-7', begun).phases['apply-machine']).toBe('going');
    // The other machine's step, were it sent under this line's id, is still not this run's.
    expect(routed(run, flight, 'argus-7', { vm: 'web', step: 'apply-machine', state: 'begun' })).toBe(run);
  });

  it('a step that arrives after its line ended moves nothing: no line is in flight then', () => {
    const run: BuildRun = buildRun_start('store', '', 0);
    expect(routed(run, null, 'argus-7', { vm: 'store', step: 'plan-data', state: 'begun' })).toBe(run);
  });
});
