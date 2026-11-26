/**
 * @file The shell's own REPL, constructed for real over a readline on
 * streams: a line typed while the shell is still starting (its history
 * being read, its first prompt being drawn) is clean in recall the moment
 * it is read, is not lost, and runs as typed once the first prompt stands.
 */
import { jest, describe, it, expect, afterAll } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const root: string = mkdtempSync(join(tmpdir(), 'chell-repl-'));
const historyFile: string = join(root, 'history');
writeFileSync(historyFile, 'an older line\nconnect --password oldsecret url\n', { mode: 0o600 });

const input: PassThrough = new PassThrough();
const realReadline = await import('readline');
jest.unstable_mockModule('readline', () => ({
  ...realReadline,
  // The REPL's own reader, over streams in place of a terminal that is not there.
  createInterface: (options: Record<string, unknown>) => realReadline.createInterface({ ...options, input, output: new PassThrough(), terminal: true }),
}));
jest.unstable_mockModule('@fnndsc/brasa', () => ({
  session: {},
  surface_set: jest.fn(),
  sink_set: jest.fn(),
  StdoutSink: class {},
  segment_pipeThrough: jest.fn(),
  file_read: jest.fn(),
  wireName_place: jest.fn(),
}));
jest.unstable_mockModule('../src/config/settings.js', () => ({ settings: { config: { historyFile, historySize: 100 } } }));
/** Lets the first prompt finish; the shell is still starting until it is called. */
let prompt_finish: () => void = (): void => undefined;
let prompts: number = 0;
jest.unstable_mockModule('../src/core/prompt/session.js', () => ({
  // The first prompt is slow, as a session's is while it warms: start-up waits on it.
  sessionPrompt_render: (): Promise<string> => { prompts += 1; return prompts === 1 ? new Promise((resolve) => { prompt_finish = (): void => resolve('> '); }) : Promise.resolve('> '); },
}));
/** The lines the shell ran, as it handed them to the engine. */
const ran: string[] = [];
jest.unstable_mockModule('../src/core/surfaceDispatch.js', () => ({
  surfaceLine_executeSafely: async (_engine: unknown, line: string): Promise<unknown[]> => { ran.push(line); return []; },
}));
jest.unstable_mockModule('../src/core/gamePlayer.js', () => ({ game_play: jest.fn(), gameShow_find: (): null => null, gameTerminal_is: (): boolean => false }));
jest.unstable_mockModule('../src/core/progressRenderer.js', () => ({ TerminalProgressRenderer: class { clear(): void { /* nothing drawn */ } } }));

// This shell is a browser's terminal: it marks its state for the page that hosts it (OSC 6677).
process.env['CHELL_TERMINAL'] = '0123abcd';
/** The states the shell marked, in order, read off what it wrote to its terminal. */
const states: string[] = [];
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
  const text: string = String(chunk);
  for (const mark of text.matchAll(/\u001b\]6677;state=([a-z]+)\u0007/g)) states.push(mark[1] as string);
  return text.includes('\u001b]6677;') ? true : (stdoutWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const { REPL } = await import('../src/core/repl.js');

const settle = (ms: number = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(() => { process.stdout.write = stdoutWrite; delete process.env['CHELL_TERMINAL']; rmSync(root, { recursive: true, force: true }); });

describe('the REPL while it starts', () => {
  it('a line typed before the first prompt is clean in recall at once, is not lost, and runs as typed when start-up ends', async () => {
    const repl = new REPL({ line_complete: async () => ({ candidates: [], prefix: '' }) } as never);
    const rl = (repl as unknown as { rl: import('readline').Interface }).rl;
    const recall = (): string[] => [...(Reflect.get(rl, 'history') as string[])];
    // Typed before start() is even called: the reader is live from its construction.
    input.write('connect --user r --password hunter2 https://cube/api/v1/\r');
    await settle();
    expect(recall()).toEqual(["connect --user r --password '***' https://cube/api/v1/"]);
    expect(ran).toEqual([]);

    const started: Promise<void> = repl.start();
    await settle();
    // The history has been read (redacted as it was) and the first prompt is still being drawn.
    expect(prompts).toBe(1);
    input.write('plugin add pl-x --adminPassword "chris 1234"\r');
    await settle();
    expect(recall()).toEqual([
      "plugin add pl-x --adminPassword '***'",
      "connect --user r --password '***' https://cube/api/v1/",
      "connect --password '***' url",
      'an older line',
    ]);
    expect(recall().join('\n')).not.toMatch(/hunter2|chris 1234|oldsecret/);
    // Nothing has run yet: the shell is still starting.
    expect(ran).toEqual([]);

    prompt_finish();
    await started;
    await settle(80);
    // Both ran, in the order typed, each with the secret its command needs.
    expect(ran).toEqual(['connect --user r --password hunter2 https://cube/api/v1/', 'plugin add pl-x --adminPassword "chris 1234"']);
    // And the file holds them as the history keeps them, after the older lines.
    expect(readFileSync(historyFile, 'utf8')).toBe("an older line\nconnect --password oldsecret url\nconnect --user r --password '***' https://cube/api/v1/\nplugin add pl-x --adminPassword '***'\n");
    // At rest again after the two lines: the last state marked is idle.
    expect(states[states.length - 1]).toBe('idle');
    rl.removeAllListeners('close');
    rl.close();
  });

  it('with nothing typed ahead, the shell says it is at rest once its first prompt stands', async () => {
    states.length = 0;
    const repl = new REPL({ line_complete: async () => ({ candidates: [], prefix: '' }) } as never);
    const rl = (repl as unknown as { rl: import('readline').Interface }).rl;
    await repl.start();
    await settle();
    // A page that hosts this terminal waits for this mark before it sends its first line.
    expect(states).toEqual(['idle']);
    expect(ran).toHaveLength(2);
    rl.removeAllListeners('close');
    rl.close();
  });
});
