/**
 * @file What a screen's host reads off the session: how a line ended, and
 * whose a question is, from typed state alone.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { ExecuteOutcome } from '../../src/calypso/client.js';
import type { VmStepEvent } from '@fnndsc/menu';
import { askAbout_read, AskKeeper, askOwner_find, flight_owns, runEnd_read, type LineInFlight, type LineOwner } from '../../src/app/lineRun.js';
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

describe('how a line ended, by its exit status and its errors', () => {
  it('a line that ended badly with no error answer is not done: the daemon\'s exit status says so', () => {
    const end = runEnd_read({ envelopes: [{ status: 'ok', rendered: 'looked fine\n' }], liveChannels: new Set(), exitCode: 2 });
    expect(end.ok).toBe(false);
    expect(end.why).toEqual(['the line ended with status 2, and the session gave no reason']);
    // Status zero, or none said (an older daemon): the answers decide.
    expect(runEnd_read({ envelopes: [{ status: 'ok', rendered: '' }], liveChannels: new Set(), exitCode: 0 }).ok).toBe(true);
    expect(runEnd_read({ envelopes: [{ status: 'ok', rendered: '' }], liveChannels: new Set() }).ok).toBe(true);
    expect(runEnd_read({ envelopes: [{ status: 'error', rendered: '' }], liveChannels: new Set() })).toEqual({ ok: false, declined: false, why: ['the session refused it, and gave no reason'] });
  });

  it('the reason is the errors an answer carries, before what it said on its error channel, and never what it printed', () => {
    const end = runEnd_read(outcome_make([
      { status: 'ok', rendered: 'downloading 3 of 9\nalmost there\n' },
      { status: 'error', rendered: 'a table, printed\n', renderedErr: 'vm build: something long and coloured\n', errors: [{ type: 'error', message: 'the plan reads a new machine' }] },
    ]));
    expect(end.why).toEqual(['the plan reads a new machine']);
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

describe('a question goes to the screen whose line raised it', () => {
  /** A screen that runs lines: the ids of those it still waits on, and whether it is showing. */
  function owner_make(name: string): LineOwner & { name: string; waiting: Set<string>; showing: boolean } {
    const waiting: Set<string> = new Set();
    return { name, waiting, showing: true, line_owns: (id: string): boolean => waiting.has(id) };
  }

  it('the VM controller\'s question is the VM controller\'s while the script screen has a line of its own outstanding', () => {
    const script = owner_make('script');
    const vm = owner_make('vm');
    script.waiting.add('argus-7');
    vm.waiting.add('argus-9');
    expect(askOwner_find('argus-9', [script, vm])?.name).toBe('vm');
    expect(askOwner_find('argus-7', [script, vm])?.name).toBe('script');
  });

  it('it stays so while that screen is left and when it is opened again; once the line has ended it is nobody\'s here', () => {
    const script = owner_make('script');
    const vm = owner_make('vm');
    vm.waiting.add('argus-9');
    // Left: another screen shows, and is busy with a line of its own.
    vm.showing = false;
    script.waiting.add('argus-12');
    expect(askOwner_find('argus-9', [script, vm])?.name).toBe('vm');
    vm.showing = true;
    expect(askOwner_find('argus-9', [script, vm])?.name).toBe('vm');
    vm.waiting.delete('argus-9');
    expect(askOwner_find('argus-9', [script, vm])).toBeNull();
  });

  it('a line no screen sent, or a question whose line the daemon did not name, has no owner among them', () => {
    const vm = owner_make('vm');
    vm.waiting.add('argus-9');
    expect(askOwner_find('argus-3', [vm])).toBeNull();
    expect(askOwner_find(undefined, [vm])).toBeNull();
  });

});

describe('a question kept while its screen is away', () => {
  const request = { message: 'the new password', kind: 'secret' as const, executeId: 'argus-9', purpose: 'stratus.chris.password.new', subject: { vm: 'store', account: 'jennings' } };

  it('is kept as it arrived, id and all, whatever the screen showed of it; and is whose it is by the line in flight on return', () => {
    const keeper: AskKeeper = new AskKeeper(60_000);
    keeper.standing_note(request);
    // The screen is left: it can say only the words and the kind it showed.
    keeper.standing_keep({ message: request.message, kind: request.kind }, (): void => undefined);
    const waiting = keeper.held_take();
    expect(waiting?.request).toBe(request);
    // Its own line still in flight: the row's own question, and it may be answered from the row.
    expect(askAbout_read(waiting?.request ?? request, { id: 'argus-9', line: 'chris passwd jennings --on store' }).mine).toBe(true);
    // Left and opened a second time: still the same question, still judged afresh.
    keeper.standing_keep({ message: request.message, kind: request.kind }, (): void => undefined);
    const second = keeper.held_take();
    expect(second?.request).toBe(request);
    // By then its line had ended and the same line was sent again, under a new id: a stale question, nobody's own,
    // though its purpose, its subject and its line's words are the very same.
    const stale = askAbout_read(second?.request ?? request, { id: 'argus-15', line: 'chris passwd jennings --on store' });
    expect(stale).toEqual({ mine: false, line: null, purpose: 'stratus.chris.password.new', subject: { vm: 'store', account: 'jennings' } });
  });

  it('a question answered is forgotten; one the keeper never saw is kept as the screen showed it', () => {
    const keeper: AskKeeper = new AskKeeper(60_000);
    keeper.standing_note(request);
    keeper.standing_clear(request);
    keeper.standing_keep({ message: 'an older host\'s question', kind: 'text' }, (): void => undefined);
    expect(keeper.held_take()?.request).toEqual({ message: 'an older host\'s question', kind: 'text' });
    expect(keeper.held_take()).toBeNull();
  });

  it('one held is abandoned when another takes its place, and when nobody comes for it within its bound', () => {
    jest.useFakeTimers();
    try {
      const keeper: AskKeeper = new AskKeeper(1000);
      const answers: Array<string | null> = [];
      keeper.held_keep({ request, resolve: (value: string | null): void => { answers.push(value); } });
      keeper.held_keep({ request: { ...request, executeId: 'argus-10' }, resolve: (value: string | null): void => { answers.push(value === null ? 'second abandoned' : value); } });
      expect(answers).toEqual([null]);
      jest.advanceTimersByTime(1000);
      expect(answers).toEqual([null, 'second abandoned']);
      expect(keeper.held_take()).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
