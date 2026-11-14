/**
 * @file Joblets: `line &` runs a line in the background (#1273). Its output
 * goes to its log, its surface hears it start and end, a question pauses it
 * until someone answers, and it holds what its line changes.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandEnvelope, AmbientEvent } from '@fnndsc/menu';

type Fake = (line: string, options: { ended?: (code: number) => void }) => Promise<CommandEnvelope[]>;
let fake: Fake = async (): Promise<CommandEnvelope[]> => [];
jest.unstable_mockModule('../src/core/engine.js', () => ({
  line_execute: (line: string, options: { ended?: (code: number) => void }): Promise<CommandEnvelope[]> => fake(line, options),
}));
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/chris' },
}));

const { joblet_start, jobletLine_parse, jobletsSource, jobletQuestion_get, jobletWord_parse, JOBLETS_SOURCE_ID } = await import('../src/core/joblets.js');
const { JobRunner, runner_install, runner_get } = await import('../src/core/runner.js');
const { ambient_listen } = await import('../src/core/ambient.js');
const { sink_dataLine } = await import('../src/core/sink.js');
const { surface_get, surface_set, HeadlessSurface } = await import('../src/core/surface.js');
const { lineOrigin_run } = await import('../src/core/lineOrigin.js');
const { commands_register } = await import('../src/core/commandRegistry.js');
const { builtin_fg, builtin_joblets } = await import('../src/builtins/sys/joblets.js');
const { sinkScope_run, BufferSink } = await import('../src/core/sink.js');

let root: string;
let heard: AmbientEvent[];
let stopListening: () => void;
const holds: string[] = [];

beforeEach((): void => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'joblets-'));
  runner_install(new JobRunner(root, [jobletsSource], (): boolean => false));
  heard = [];
  stopListening = ambient_listen((event: AmbientEvent): void => { heard.push(event); });
  holds.length = 0;
  const host = new HeadlessSurface();
  (host as unknown as { hold: (h: string[] | 'all') => Promise<() => void> }).hold = async (h: string[] | 'all'): Promise<() => void> => {
    holds.push(`take ${JSON.stringify(h)}`);
    return (): void => { holds.push('give'); };
  };
  surface_set(host);
  commands_register({ holds: { look: [] } });
});

afterEach((): void => {
  stopListening();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The text of the envelope notices heard, in order. */
const notices = (): string[] => heard.filter((event: AmbientEvent): boolean => event.kind === 'envelope')
  .map((event: AmbientEvent): string => (event as { envelope: CommandEnvelope }).envelope.rendered.trim());

/** Waits for a joblet's end. */
async function ended(number: number): Promise<{ state: string; outcome?: string }> {
  const record = await runner_get()!.job_follow(JOBLETS_SOURCE_ID, String(number), (): void => undefined);
  return record as { state: string; outcome?: string };
}

describe('a line that ends with &', () => {
  it('is a joblet; && , \\& and a quoted & are not', () => {
    expect(jobletLine_parse('pull pacs x &')).toBe('pull pacs x');
    expect(jobletLine_parse('pull pacs x&')).toBe('pull pacs x');
    expect(jobletLine_parse('a && b')).toBeNull();
    expect(jobletLine_parse('echo a\\&')).toBeNull();
    expect(jobletLine_parse('echo "a &')).toBeNull();
    expect(jobletLine_parse('&')).toBeNull();
    expect(jobletLine_parse('ls')).toBeNull();
  });
});

describe('a joblet', () => {
  it('starts with a notice, needs no tier, logs its output, and its surface alone hears it end', async () => {
    fake = async (line: string): Promise<CommandEnvelope[]> => { sink_dataLine('pulling'); return [{ status: 'ok', rendered: `did ${line}\n` }]; };
    const started: CommandEnvelope = await lineOrigin_run('surface-a', () => joblet_start('look x'));
    expect(started.rendered).toBe('[1] look x &\n');
    expect((await ended(1)).state).toBe('done');
    expect(runner_get()!.log_read(JOBLETS_SOURCE_ID, '1')?.replace(/^\S+ /gm, '')).toBe('pulling\ndid look x\n');
    const end = heard.find((event: AmbientEvent): boolean => event.kind === 'envelope') as { envelope: CommandEnvelope; origin?: string };
    expect(end.envelope.rendered).toBe('[1]+ Done  look x\n');
    expect(end.origin).toBe('surface-a');
    // It held what its line changes (nothing), and gave it back.
    expect(holds).toEqual(['take []', 'give']);
  });

  it('hands a model it answered with to its surface, and its progress too', async () => {
    fake = async (): Promise<CommandEnvelope[]> => {
      (await import('../src/core/sink.js')).sink_get().progress_write({ operation: 'pull', phase: 'watching', itemId: '1.2', status: 'done', current: 3, total: 3 } as never);
      return [{ status: 'ok', rendered: '', model: { kind: 'gather.cohort', data: { series: [] } } }];
    };
    await lineOrigin_run('surface-a', () => joblet_start('look pull'));
    expect((await ended(1)).state).toBe('done');
    const model = heard.find((event: AmbientEvent): boolean => event.kind === 'envelope' && (event as { envelope: CommandEnvelope }).envelope.model?.kind === 'gather.cohort') as { origin?: string } | undefined;
    expect(model?.origin).toBe('surface-a');
    const progress = heard.find((event: AmbientEvent): boolean => event.kind === 'progress') as { origin: string; id: string; progress: { itemId?: string } } | undefined;
    expect(progress).toMatchObject({ origin: 'surface-a', id: 'joblet-1', progress: { itemId: '1.2' } });
    expect(runner_get()!.job_get(JOBLETS_SOURCE_ID, '1')?.progress).toEqual({ current: 3, total: 3 });
  });

  it('lets its line read that it runs in a joblet, which a line in front does not', async () => {
    const { jobletCurrent_get } = await import('../src/core/jobletScope.js');
    let inside: number | null = null;
    fake = async (): Promise<CommandEnvelope[]> => { await Promise.resolve(); inside = jobletCurrent_get(); return []; };
    expect(jobletCurrent_get()).toBeNull();
    await lineOrigin_run('surface-a', () => joblet_start('look x'));
    expect((await ended(1)).state).toBe('done');
    expect(inside).toBe(1);
    expect(jobletCurrent_get()).toBeNull();
  });

  it('fails with its exit status and its last error line', async () => {
    fake = async (_line: string, options: { ended?: (code: number) => void }): Promise<CommandEnvelope[]> => {
      options.ended?.(2);
      return [{ status: 'error', rendered: '', renderedErr: 'pull: first\npull: the PACS refused\n' }];
    };
    await joblet_start('pull pacs x');
    expect((await ended(1)).state).toBe('failed');
    expect(notices()).toEqual(['[1]+ Failed (exit 2): pull: the PACS refused']);
    // An undeclared command holds the whole session.
    expect(holds).toEqual(['take "all"', 'give']);
  });

  it('numbers past the highest still running, as a shell does', async () => {
    let release: () => void = (): void => undefined;
    const held: Promise<void> = new Promise<void>((resolve: () => void): void => { release = resolve; });
    fake = async (): Promise<CommandEnvelope[]> => { await held; return [{ status: 'ok', rendered: '' }]; };
    expect((await joblet_start('look a')).rendered).toBe('[1] look a &\n');
    expect((await joblet_start('look b')).rendered).toBe('[2] look b &\n');
    expect(jobletWord_parse('%%')).toBe(2);
    expect(jobletWord_parse('%1')).toBe(1);
    release();
    await ended(1);
    await ended(2);
    expect((await joblet_start('look c')).rendered).toBe('[1] look c &\n');
    await ended(1);
  });

  it('pauses at a question, says so, gives up its hold, and goes on when answered', async () => {
    fake = async (): Promise<CommandEnvelope[]> => {
      const name: string = await surface_get().prompt({ message: 'type the name: ' });
      return [{ status: 'ok', rendered: `got ${name}\n` }];
    };
    await lineOrigin_run('surface-a', () => joblet_start('look teardown'));
    for (let tries: number = 0; tries < 50 && jobletQuestion_get(1) === null; tries += 1) await new Promise((r) => setTimeout(r, 5));
    expect(notices()).toEqual(['[1]+ Waiting for an answer: type the name: · fg %1 to answer']);
    expect(holds).toEqual(['take []', 'give']);
    jobletQuestion_get(1)!.answer('quay');
    expect((await ended(1)).state).toBe('done');
    expect(runner_get()!.log_read(JOBLETS_SOURCE_ID, '1')).toContain('got quay');
    expect(holds).toEqual(['take []', 'give', 'take []', 'give']);
  });

  it('a kill ends it where it waits on a question', async () => {
    fake = async (): Promise<CommandEnvelope[]> => {
      await surface_get().prompt({ message: 'sure? ' });
      return [{ status: 'ok', rendered: '' }];
    };
    await joblet_start('look x');
    for (let tries: number = 0; tries < 50 && jobletQuestion_get(1) === null; tries += 1) await new Promise((r) => setTimeout(r, 5));
    expect(runner_get()!.job_stop(JOBLETS_SOURCE_ID, '1')).toBe('stopping');
    expect((await ended(1)).state).toBe('cancelled');
    expect(notices().pop()).toBe('[1]+ Stopped  look x');
  });
});

describe('fg', () => {
  it('asks the joblet\'s question on its own surface, follows it to the end, and ends with its status', async () => {
    fake = async (): Promise<CommandEnvelope[]> => {
      const name: string = await surface_get().prompt({ message: 'type the name: ' });
      sink_dataLine(`tearing down ${name}`);
      return [{ status: 'ok', rendered: '' }];
    };
    const asked: string[] = [];
    (surface_get() as unknown as { prompt: (r: { message: string }) => Promise<string> }).prompt = async (request: { message: string }): Promise<string> => {
      asked.push(request.message);
      return 'quay';
    };
    await joblet_start('look teardown');
    const shown: InstanceType<typeof BufferSink> = new BufferSink();
    const envelope: CommandEnvelope = await sinkScope_run(shown, () => builtin_fg(['%1']));
    expect(envelope.status).toBe('ok');
    expect(asked).toEqual(['type the name: ']);
    expect(shown.text_get()).toContain('tearing down quay');
    const listed: CommandEnvelope = await builtin_joblets([]);
    expect(listed.rendered).toMatch(/^\[1\]  Done\s+look teardown\n$/);
  });

  it('refuses a joblet that is not there', async () => {
    expect((await builtin_fg(['%9'])).renderedErr).toBe('fg: %9: no such joblet\n');
  });
});

