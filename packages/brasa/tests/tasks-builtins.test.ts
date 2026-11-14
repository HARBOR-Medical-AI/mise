/**
 * @file `kill` and `wait` over the runner's jobs.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandEnvelope } from '@fnndsc/menu';
import { JobRunner, runner_install, type JobContext, type JobRun } from '../src/core/runner.js';
import { builtin_kill, builtin_wait, jobName_resolve } from '../src/builtins/sys/tasks.js';
import { BufferSink, sink_set } from '../src/core/sink.js';

/** A job that waits for its release, or for its stop. */
function job_held(): { run: JobRun; release: () => void } {
  let release: () => void = (): void => {};
  const run: JobRun = (context: JobContext): Promise<void> => new Promise((resolve: () => void): void => {
    release = (): void => { context.log_write('released'); resolve(); };
    context.signal.addEventListener('abort', (): void => resolve(), { once: true });
  });
  return { run, release: (): void => release() };
}

describe('kill and wait', () => {
  let root: string;
  let runner: JobRunner;
  let sink: BufferSink;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
    runner = new JobRunner(root, [{ id: 'steps', label: 'steps' }, { id: 'other', label: 'other' }], () => true);
    runner_install(runner);
    sink = new BufferSink();
    sink_set(sink);
  });
  afterEach(() => { runner_install(null); fs.rmSync(root, { recursive: true, force: true }); });

  it('names a job by its path, its source and id, or its id alone when one source has it', async () => {
    runner.job_start('steps', 'a', 'A', job_held().run);
    runner.job_start('steps', 'b', 'B', job_held().run);
    runner.job_start('other', 'b', 'B', job_held().run);
    expect(jobName_resolve(runner, '/proc/steps/a')).toEqual({ source: 'steps', id: 'a' });
    expect(jobName_resolve(runner, 'steps/a')).toEqual({ source: 'steps', id: 'a' });
    expect(jobName_resolve(runner, 'a')).toEqual({ source: 'steps', id: 'a' });
    expect(jobName_resolve(runner, 'b')).toEqual({ error: 'ambiguous: /proc/other/b, /proc/steps/b' });
    expect(jobName_resolve(runner, 'zz')).toEqual({ error: 'no such task' });
    expect(jobName_resolve(runner, '/proc/a/b/c')).toEqual({ error: 'no such task' });
  });

  it('kill asks quietly, says so the second time, and never forces', async () => {
    // A job that finishes its current operation before it stops.
    let finish: () => void = (): void => {};
    const { finished } = runner.job_start('steps', 'a', 'A', (): Promise<void> => new Promise((resolve: () => void): void => { finish = resolve; }));
    const first: CommandEnvelope = await builtin_kill(['a']);
    expect(first).toMatchObject({ status: 'ok', rendered: '' });
    const second: CommandEnvelope = await builtin_kill(['/proc/steps/a', 'zz']);
    finish();
    await finished;
    expect(second.status).toBe('error');
    expect(second.renderedErr).toBe('kill: /proc/steps/a: already asked to stop; it ends when its current operation does\nkill: zz: no such task\n');
    expect((await builtin_kill(['a'])).renderedErr).toBe('kill: a: not running (cancelled)\n');
    expect((await builtin_kill(['-9', 'a'])).renderedErr).toBe("kill: invalid option -- '9'; usage: kill <task…>\n");
    expect((await builtin_kill([])).renderedErr).toBe('kill: missing operand <task>; usage: kill <task…>\n');
  });

  it('wait follows the log to the end and takes the job\'s status', async () => {
    const held = job_held();
    runner.job_start('steps', 'a', 'A', held.run);
    const waiting: Promise<CommandEnvelope> = builtin_wait(['a']);
    held.release();
    expect((await waiting).status).toBe('ok');
    expect(sink.text_get()).toMatch(/\d\d:\d\d:\d\d released\n/);
    await runner.job_start('steps', 'f', 'F', async () => { throw new Error('quota'); }).finished;
    expect((await builtin_wait(['f'])).renderedErr).toBe('wait: /proc/steps/f: failed (quota)\n');
    expect((await builtin_wait(['zz'])).renderedErr).toBe('wait: zz: no such task\n');
    expect((await builtin_wait(['-n'])).renderedErr).toBe("wait: invalid option -- 'n'; usage: wait [task…]\n");
  });

  it('bare wait waits for every running job', async () => {
    const one = job_held();
    const two = job_held();
    runner.job_start('steps', 'a', 'A', one.run);
    runner.job_start('other', 'b', 'B', two.run);
    const waiting: Promise<CommandEnvelope> = builtin_wait([]);
    one.release();
    two.release();
    const envelope: CommandEnvelope = await waiting;
    expect(envelope.status).toBe('ok');
  });

  it('says when the session runs no tasks', async () => {
    runner_install(null);
    expect((await builtin_kill(['a'])).renderedErr).toBe('kill: this session runs no tasks\n');
    expect((await builtin_wait(['a'])).renderedErr).toBe('wait: this session runs no tasks\n');
    expect((await builtin_wait([])).status).toBe('ok');
  });
});
