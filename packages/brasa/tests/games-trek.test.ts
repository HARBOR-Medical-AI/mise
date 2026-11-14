/**
 * @file The session's `trek`: the bsd-trek game wired to the session, its
 * lines to the data channel and its prompts asked as questions. The game
 * itself is tested in the bsd-trek package, against the original's
 * transcripts.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
}));
const answers: string[] = [];
let written: string = '';
jest.unstable_mockModule('../src/core/question.js', () => ({
  repl_question: async (prompt: string): Promise<string> => {
    written += prompt;
    const next: string | undefined = answers.shift();
    if (next === undefined) throw new Error('no surface');
    if (next === '<abandon>') throw new Error('the operator abandoned the question');
    return next;
  },
}));
const events: { kind: string; data: unknown }[] = [];
jest.unstable_mockModule('../src/core/sink.js', () => ({ sink_get: () => ({ data_write: (text: string): void => { written += text; }, event_write: (kind: string, data: unknown): void => { events.push({ kind, data }); } }) }));

const { builtin_trek } = await import('../src/builtins/games/trek.js');

beforeEach(() => { answers.length = 0; written = ''; events.length = 0; });

describe('the trek command', () => {
  it('refuses an unknown flag by name', async () => {
    const refused = await builtin_trek(['--warp']);
    expect(refused.status).toBe('error');
    expect((refused as { renderedErr?: string }).renderedErr).toContain("unrecognized option '--warp'");
    expect(((await builtin_trek(['extra'])) as { renderedErr?: string }).renderedErr).toContain('usage: trek');
  });

  it('--credits answers with the credits, no game played', async () => {
    const shown = await builtin_trek(['--credits']);
    expect((shown as { rendered?: string }).rendered).toContain('Rudolph Pienaar');
    expect((shown as { model?: { kind: string } }).model?.kind).toBe('games.trek.credits');
  });

  it('plays a seeded classic game through the session, prompts as questions', async () => {
    answers.push('', 's', 'n', 'pw', 'terminate', 'n');
    const ended = await builtin_trek(['--classic', '--seed', '42', '-f', '-s']);
    expect(ended.status).toBe('ok');
    expect(ended.model).toEqual({ kind: 'games.trek', data: { seed: 42, exit: 0 } });
    expect(written).toContain('S T A R   T R E K');
    expect(written).toContain('What length game: ');
    expect(written).toContain('\nCommand: ');
  });

  it('shows the game state as a games.trek.state event at every Command: prompt', async () => {
    answers.push('', 's', 'n', 'pw', 'srscan', 'terminate', 'n');
    await builtin_trek(['--classic', '--seed', '42', '-f', '-s']);
    const states = events.filter((e) => e.kind === 'games.trek.state');
    expect(states.length).toBe((written.match(/\nCommand: /g) ?? []).length);
    const state = states[0]?.data as { Ship: { energy: number; quadx: number }; Now: { klings: number; date: number } };
    expect(state.Ship.energy).toBeGreaterThan(0);
    expect(state.Now.klings).toBeGreaterThan(0);
    // it survives the wire: plain data, no functions or cycles
    expect(JSON.parse(JSON.stringify(state)).Now.date).toBe(state.Now.date);
  });

  it('a question the operator abandons is end of input: the game ends, no error', async () => {
    answers.push('', 's', 'n', 'pw', '<abandon>');
    const ended = await builtin_trek(['--seed', '42', '-f']);
    expect(ended.status).toBe('ok');
    expect((ended.model as { kind: string }).kind).toBe('games.trek');
    expect((ended as { renderedErr?: string }).renderedErr).toBeUndefined();
  });

  it('says so when the session cannot ask', async () => {
    const ended = await builtin_trek(['--seed', '1']);
    expect(ended.status).toBe('error');
    expect((ended as { renderedErr?: string }).renderedErr).toContain('trek: cannot ask here');
  });
});
