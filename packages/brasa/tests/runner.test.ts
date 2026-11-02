/**
 * @file The runner: jobs started behind the tasks tier, kept on disk,
 * stopped gently, followed, and picked up again after a restart.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AmbientEvent, Task } from '@fnndsc/menu';
import { JobRefusal, JobRunner, jobsRoot_derive, runner_get, runner_install, type JobContext, type JobRecord, type JobRun, type JobSource } from '../src/core/runner.js';
import { ambient_listen } from '../src/core/ambient.js';
import { surface_set, HeadlessSurface } from '../src/core/surface.js';

const STEPS: JobSource = { id: 'steps', label: 'build steps' };

/** A job that waits for its release, or for its stop. */
function job_held(): { run: JobRun; release: () => void } {
  let release: () => void = (): void => {};
  const run: JobRun = (context: JobContext): Promise<void> => new Promise((resolve: () => void): void => {
    context.log_write('waiting');
    release = (): void => resolve();
    context.signal.addEventListener('abort', (): void => { context.log_write('stopping'); resolve(); }, { once: true });
  });
  return { run, release: (): void => release() };
}

describe('the runner', () => {
  let root: string;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); runner_install(null); });

  it('keeps its jobs under the state folder, per backend', () => {
    expect(jobsRoot_derive('stratus', { XDG_STATE_HOME: '/s' })).toBe('/s/stratus/jobs');
    expect(jobsRoot_derive('stratus', {})).toBe(path.join(os.homedir(), '.local', 'state', 'stratus', 'jobs'));
  });

  it('refuses to start a job without the tasks tier, as the surface declares it', () => {
    surface_set(new HeadlessSurface());
    const runner: JobRunner = new JobRunner(root, [STEPS]);
    expect(() => runner.job_start('steps', 'a', 'A', async () => {})).toThrow(JobRefusal);
    expect(() => runner.job_start('steps', 'a', 'A', async () => {})).toThrow('starting a task needs the tasks tier');
    const granted: HeadlessSurface = new HeadlessSurface();
    (granted.capabilities as { tasks?: boolean }).tasks = true;
    surface_set(granted);
    const allowed: JobRunner = new JobRunner(root, [STEPS]);
    expect(allowed.job_start('steps', 'a', 'A', async () => {}).record.state).toBe('running');
    surface_set(new HeadlessSurface());
  });

  it('refuses an unknown source, a bad name, and an id still running', () => {
    const runner: JobRunner = new JobRunner(root, [STEPS], () => true);
    expect(() => runner.job_start('nope', 'a', 'A', async () => {})).toThrow('no task source nope');
    expect(() => runner.job_start('steps', '../a', 'A', async () => {})).toThrow("a task's name is");
    const held = job_held();
    runner.job_start('steps', 'a', 'A', held.run);
    expect(() => runner.job_start('steps', 'a', 'A', held.run)).toThrow('already running (/proc/steps/a)');
    held.release();
  });

  it('records progress, log and data on disk, and how a job ended', async () => {
    const runner: JobRunner = new JobRunner(root, [STEPS], () => true);
    const heard: AmbientEvent[] = [];
    const stop: () => void = ambient_listen((event: AmbientEvent): void => { heard.push(event); });
    const { finished } = runner.job_start('steps', 'build', 'build trial', async (context: JobContext): Promise<void> => {
      context.progress_set({ current: 1, total: 3 });
      context.data_set('stackId', 'ocid1.stack');
      context.log_write('plan job done');
    }, { domain: 'trial' });
    const record: JobRecord = await finished;
    stop();
    expect(record).toMatchObject({ state: 'done', progress: { current: 1, total: 3 }, data: { domain: 'trial', stackId: 'ocid1.stack' }, outcome: 'done' });
    expect(record.ended).toBeDefined();
    const saved: JobRecord = JSON.parse(fs.readFileSync(path.join(root, 'steps', 'build.json'), 'utf-8')) as JobRecord;
    expect(saved.state).toBe('done');
    expect(runner.log_read('steps', 'build')).toMatch(/^\d\d:\d\d:\d\d plan job done\n$/);
    expect(heard).toEqual([expect.objectContaining({ kind: 'envelope', envelope: expect.objectContaining({ rendered: '/proc/steps/build: done\n' }) })]);
  });

  it('marks a job that throws failed, with its reason in the log', async () => {
    const runner: JobRunner = new JobRunner(root, [STEPS], () => true);
    const record: JobRecord = await runner.job_start('steps', 'x', 'X', async () => { throw new Error('quota exceeded'); }).finished;
    expect(record).toMatchObject({ state: 'failed', outcome: 'quota exceeded' });
    expect(runner.log_read('steps', 'x')).toContain('failed: quota exceeded');
  });

  it('stops a job gently, and says so the second time rather than forcing it', async () => {
    const runner: JobRunner = new JobRunner(root, [STEPS], () => true);
    const held = job_held();
    const { finished } = runner.job_start('steps', 'a', 'A', held.run);
    expect(runner.job_stop('steps', 'a')).toBe('stopping');
    expect(runner.job_stop('steps', 'a')).toBe('already-stopping');
    expect((await finished).state).toBe('cancelled');
    expect(runner.job_stop('steps', 'a')).toBe('not-running');
    expect(runner.job_stop('steps', 'nope')).toBe('unknown');
    expect(runner.log_read('steps', 'a')).toContain('asked to stop; it ends when its current operation does');
  });

  it('follows a job line by line to its end, and lets go without stopping it', async () => {
    const runner: JobRunner = new JobRunner(root, [STEPS], () => true);
    const held = job_held();
    runner.job_start('steps', 'a', 'A', held.run);
    const lines: string[] = [];
    const following: Promise<JobRecord | undefined> = runner.job_follow('steps', 'a', (line: string): void => { lines.push(line); });
    expect(lines[0]).toMatch(/waiting$/);
    held.release();
    expect((await following)?.state).toBe('done');
    const second = job_held();
    runner.job_start('steps', 'b', 'B', second.run);
    const controller: AbortController = new AbortController();
    const letGo: Promise<JobRecord | undefined> = runner.job_follow('steps', 'b', () => {}, controller.signal);
    controller.abort();
    expect((await letGo)?.state).toBe('running');
    // A follow asked to stop before it began ends at once, the job untouched.
    const already: AbortController = new AbortController();
    already.abort();
    const never: Promise<JobRecord | undefined> = runner.job_follow('steps', 'b', () => {}, already.signal);
    expect((await Promise.race([never, new Promise<string>((resolve) => { setTimeout(() => resolve('late'), 200); })]) as JobRecord)?.state).toBe('running');
    second.release();
    expect(await runner.job_follow('steps', 'nope', () => {})).toBeUndefined();
  });

  it('follows aside: out of the turn while the job is quiet, each line heard in the follower\'s turn', async () => {
    const runner: JobRunner = new JobRunner(root, [STEPS], () => true);
    const held = job_held();
    runner.job_start('steps', 'c', 'C', held.run);
    // A host that counts how often the follower stepped out, and whether it was out when a line was given.
    let out: boolean = false;
    let asides: number = 0;
    const host = new HeadlessSurface();
    (host as unknown as { aside: <T>(waiting: Promise<T>) => Promise<T> }).aside = async <T>(waiting: Promise<T>): Promise<T> => {
      asides++;
      out = true;
      try { return await waiting; } finally { out = false; }
    };
    surface_set(host);
    const given: Array<{ line: string; out: boolean }> = [];
    const following: Promise<JobRecord | undefined> = runner.job_followAside('steps', 'c', (line: string): void => { given.push({ line, out }); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asides).toBe(1);
    held.release();
    expect((await following)?.state).toBe('done');
    expect(given.map((entry) => entry.line.replace(/^\S+ /, ''))).toEqual(['waiting']);
    expect(given.every((entry) => !entry.out)).toBe(true);
    // Stopped following, it lets go and the job goes on.
    const next = job_held();
    runner.job_start('steps', 'd', 'D', next.run);
    const controller: AbortController = new AbortController();
    const letGo: Promise<JobRecord | undefined> = runner.job_followAside('steps', 'd', () => {}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect((await letGo)?.state).toBe('running');
    next.release();
    surface_set(new HeadlessSurface());
  });

  it('reads its jobs back after a restart, and picks up those its source can resume', async () => {
    const first: JobRunner = new JobRunner(root, [STEPS], () => true);
    const held = job_held();
    first.job_start('steps', 'apply', 'apply', async (context: JobContext): Promise<void> => { context.data_set('jobId', 'rm-1'); await held.run(context); });
    first.job_start('steps', 'other', 'other', job_held().run);
    let resumedWith: string | undefined;
    const source: JobSource = {
      ...STEPS,
      resume: (record: JobRecord): JobRun | null => record.id === 'apply' ? async (context: JobContext): Promise<void> => { resumedWith = context.data['jobId'] as string; } : null,
    };
    const second: JobRunner = new JobRunner(root, [source], () => true);
    expect(second.jobs_list().map((record: JobRecord) => record.state)).toEqual(['running', 'running']);
    expect(second.jobs_resume()).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(resumedWith).toBe('rm-1');
    expect(second.job_get('steps', 'apply')?.state).toBe('done');
    expect(second.job_get('steps', 'other')).toMatchObject({ state: 'failed', outcome: expect.stringContaining('cannot be picked up again') });
    held.release();
  });

  it('marks a running job failed when the session restarts without the tier', () => {
    new JobRunner(root, [STEPS], () => true).job_start('steps', 'a', 'A', job_held().run);
    const after: JobRunner = new JobRunner(root, [{ ...STEPS, resume: () => async () => {} }], () => false);
    expect(after.jobs_resume()).toBe(0);
    expect(after.job_get('steps', 'a')?.outcome).toContain('without the tasks tier');
  });

  it('shows its jobs as task sources, newest first, with their log', async () => {
    const runner: JobRunner = new JobRunner(root, [STEPS], () => true);
    await runner.job_start('steps', 'one', 'first', async (context: JobContext) => { context.log_write('hello'); }).finished;
    const [source] = runner.taskSources_get();
    const tasks: Task[] = await source!.list();
    expect(source!.id).toBe('steps');
    expect(tasks[0]).toMatchObject({ id: 'one', label: 'first', state: 'done' });
    expect(tasks[0]!.logTail).toContain('hello');
    expect(await source!.log!('one')).toContain('hello');
    expect(await source!.log!('none')).toBeNull();
    runner_install(runner);
    expect(runner_get()).toBe(runner);
  });
});
