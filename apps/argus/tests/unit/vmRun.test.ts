/**
 * @file A machine's build as one run: its steps move as `vm build` follows
 * its tasks, the question stands between planning and applying, and the
 * outcome is said once the line ends.
 */
import { describe, it, expect } from '@jest/globals';
import { buildQuestion_plain, buildRun_answer, buildRun_ask, buildRun_end, buildRun_start, buildRun_take, type BuildRun } from '../../src/features/vm/run.js';

describe('a build run', () => {
  it('moves through its steps as the tasks are followed, skipping what a build does not need', () => {
    let run: BuildRun = buildRun_start('store', 'disk 100 → 150 GB', 0);
    // Under way from the press: PREPARE writes and keeps the declaration and readies the stacks.
    expect(run.phases.prepare).toBe('going');
    run = buildRun_take(run, 'following /proc/steps/vm-store-plan-data; Ctrl-C stops following, not the task (wait vm-store-plan-data follows it again)');
    expect([run.phases.prepare, run.phases['plan-data']]).toEqual(['done', 'going']);
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

  it('asks the build\'s question in the screen\'s words, its buttons saying what each answer does', () => {
    expect(buildQuestion_plain('vm build store: boot disk 100 → 150 GB. Grown online, no reboot. $39.95 → $42.08 a month. A NO builds nothing; the declaration stays written. Continue? [y/N]'))
      .toEqual({ text: 'Resize store\'s boot disk 100 → 150 GB? Grown online, no reboot. $39.95 → $42.08 a month.', yes: 'YES · RESIZE', no: 'NO · BUILD NOTHING' });
    expect(buildQuestion_plain('vm build store: 2 → 4 vCPU, memory 8 → 16 GiB. store reboots to take its new shape: it, and ChRIS at https://cube.example/api/v1/, is down a few minutes. $37.83 → $71.41 a month. A NO builds nothing; the declaration stays written. Continue? [y/N]'))
      .toEqual({ text: 'Resize store: 2 → 4 vCPU, memory 8 → 16 GiB? store reboots to take its new shape: it, and ChRIS at https://cube.example/api/v1/, is down a few minutes. $37.83 → $71.41 a month.', yes: 'YES · REBOOT AND RESIZE', no: 'NO · BUILD NOTHING' });
    expect(buildQuestion_plain('vm build store: data 3 to create, 0 to change, 0 to destroy; machine planned once its data stands (2 vCPU, 8 GiB, disk 50 GB). It bills $37.83 a month ($0.052 an hour). A NO builds nothing; the declaration stays written. Made to plan it, free, and kept on a NO: its data stack fake-stack-vmData-store. Continue? [y/N]'))
      .toEqual({ text: 'Build store: data 3 to create, 0 to change, 0 to destroy; machine planned once its data stands (2 vCPU, 8 GiB, disk 50 GB)? It bills $37.83 a month ($0.052 an hour). Made to plan it, free, and kept on a NO: its data stack fake-stack-vmData-store.', yes: 'YES · BUILD', no: 'NO · BUILD NOTHING' });
    expect(buildQuestion_plain('vm build store: its data stands; now the machine: 3 to create, 0 to change, 0 to destroy (2 vCPU, 8 GiB, disk 50 GB). It bills $0.052 an hour, $37.83 a month (the data alone, kept after a teardown: $0.003 an hour, $2.13 a month) with its data. A NO makes no machine: its data stays, billing $0.003 an hour, $2.13 a month, until vm teardown store --all. Continue? [y/N]')).toEqual({
      text: 'Build store\'s machine now, 3 to create, 0 to change, 0 to destroy (2 vCPU, 8 GiB, disk 50 GB)? It bills $0.052 an hour, $37.83 a month (the data alone, kept after a teardown: $0.003 an hour, $2.13 a month) with its data. On a NO: its data stays, billing $0.003 an hour, $2.13 a month, until vm teardown store --all.',
      yes: 'YES · BUILD', no: 'NO · MAKE NO MACHINE' });
    // Another question (a teardown's) is not a build's: the strip draws it as before.
    expect(buildQuestion_plain('vm teardown store: remove its machine and boot disk; keep its data volume, backups and address 203.0.113.10. Continue? [y/N]')).toBeNull();
  });
});
