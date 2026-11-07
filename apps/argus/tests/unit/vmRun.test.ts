/**
 * @file A machine's build as one run: its steps move as `vm build` follows
 * its tasks, the question stands between planning and applying, and the
 * outcome is said once the line ends.
 */
import { describe, it, expect } from '@jest/globals';
import { buildRun_answer, buildRun_ask, buildRun_end, buildRun_start, buildRun_take, type BuildRun } from '../../src/features/vm/run.js';

describe('a build run', () => {
  it('moves through its steps as the tasks are followed, skipping what a build does not need', () => {
    let run: BuildRun = buildRun_start('store', 'disk 100 → 150 GB', 0);
    run = buildRun_take(run, 'following /proc/steps/vm-store-plan-data; Ctrl-C stops following, not the task (wait vm-store-plan-data follows it again)');
    expect(run.phases['plan-data']).toBe('going');
    run = buildRun_take(run, '21:42:20 data plan: 0 to create, 0 to change, 0 to destroy');
    expect(run.said).toBe('data plan: 0 to create, 0 to change, 0 to destroy');
    run = buildRun_take(run, 'following /proc/steps/vm-store-plan-machine; …');
    expect([run.phases['plan-data'], run.phases['plan-machine']]).toEqual(['done', 'going']);
    run = buildRun_ask(run);
    expect(run.phases.ask).toBe('going');
    run = buildRun_answer(run, true);
    run = buildRun_take(run, 'following /proc/steps/vm-store-apply-machine; …');
    // Nothing applied to the data: its step is not needed.
    expect([run.phases.ask, run.phases['apply-data'], run.phases['apply-machine']]).toEqual(['done', 'skipped', 'going']);
    run = buildRun_end(run, { tone: 'done', why: '' }, '2026-11-06T21:50:00.000Z');
    expect(run.phases['apply-machine']).toBe('done');
    expect(run.outcome?.words).toBe('BUILT · DISK 100 → 150 GB');
    // A line after the end moves nothing.
    expect(buildRun_take(run, 'following /proc/steps/vm-store-grow')).toBe(run);
  });

  it('a NO ends it with nothing changed; a refusal says why; another machine\'s task is not this run', () => {
    let run: BuildRun = buildRun_start('store', '', 0);
    expect(buildRun_take(run, 'following /proc/steps/vm-web-plan-data')).toBe(run);
    run = buildRun_answer(buildRun_ask(run), false);
    expect(run.phases.ask).toBe('skipped');
    expect(buildRun_end(run, { tone: 'declined', why: '' }, '2026-11-06T21:50:00.000Z').outcome?.words).toBe('STOPPED BEFORE THE APPLY · NOTHING CHANGED');
    expect(buildRun_end(buildRun_start('store', '', 0), { tone: 'failed', why: 'the plan reads a new machine' }, '2026-11-06T21:50:00.000Z').outcome?.words).toBe('FAILED · the plan reads a new machine');
  });
});
