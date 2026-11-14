/**
 * @file The showpieces' stills and model, and the games played by question:
 * quiz, hangman, 2048 — their boards and scoring, and a round of each with a
 * scripted surface.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
}));
const answers: string[] = [];
const lines: string[] = [];
jest.unstable_mockModule('../src/core/question.js', () => ({
  repl_question: async (_prompt: string): Promise<string> => {
    const next: string | undefined = answers.shift();
    if (next === undefined) throw new Error('no surface');
    return next;
  },
}));
jest.unstable_mockModule('../src/core/sink.js', () => ({ sink_dataLine: (text: string): void => { lines.push(text); } }));

const { still_render, builtin_sl, builtin_tetris, builtin_cmatrix, builtin_rain, builtin_asciiquarium, builtin_snake, STARSHIP } = await import('../src/builtins/games/show.js');
const { answer_matches, QUIZ_BANK, QUIZ_ROUND, builtin_quiz, word_mask, builtin_hangman, HANGMAN_WORDS, row_slide, board_move, board_spawn, board_canMove, board_render, builtin_2048 } = await import('../src/builtins/games/play.js');

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

beforeEach(() => { answers.length = 0; lines.length = 0; });

describe('showpieces', () => {
  it('a still for every program, and a games.show model naming it', async () => {
    for (const program of ['sl', 'cmatrix', 'rain', 'aquarium', 'tetris', 'snake'] as const) {
      expect(still_render(program, () => 0.5).length).toBeGreaterThan(3);
    }
    const sl = await builtin_sl([]);
    expect(sl.model).toEqual({ kind: 'games.show', data: { program: 'sl', args: [], arcade: false, pane: false } });
    expect(plain(sl.rendered)).toContain(STARSHIP[3]);
    expect(plain(sl.rendered)).toContain('a terminal plays it in place');
    const tetris = await builtin_tetris(['--pane']);
    expect(tetris.model).toEqual({ kind: 'games.show', data: { program: 'tetris', args: [], arcade: true, pane: true } });
    expect(plain(tetris.rendered)).toContain('ARGUS draws it in its GAMES pane');
    const refused = await builtin_tetris(['-x']);
    expect(refused.status).toBe('error');
    expect((refused as { renderedErr?: string }).renderedErr).toContain("invalid option -- 'x'");
    for (const [run, program, arcade] of [[builtin_cmatrix, 'cmatrix', false], [builtin_rain, 'rain', false], [builtin_asciiquarium, 'aquarium', false], [builtin_snake, 'snake', true]] as const) {
      expect((await run([])).model).toEqual({ kind: 'games.show', data: { program, args: [], arcade, pane: false } });
    }
  });
});

describe('quiz', () => {
  it('matches answers without case or punctuation', () => {
    expect(answer_matches('C-Find', ['c-find'])).toBe(true);
    expect(answer_matches('ChRIS Ultron Back End', ['chris ultron back end'])).toBe(true);
    expect(answer_matches('', ['x'])).toBe(false);
    expect(QUIZ_BANK.length).toBeGreaterThanOrEqual(QUIZ_ROUND);
  });

  it('asks a round, scores it, and stops on q', async () => {
    answers.push('wrong', 'q');
    const out = await builtin_quiz([]);
    expect(out.status).toBe('ok');
    expect(plain(out.rendered)).toContain('0 of 1');
    expect(lines.some((l: string): boolean => plain(l).startsWith('  no — '))).toBe(true);
    const model = out.model as { kind: string; data: { right: number; asked: number } };
    expect(model.kind).toBe('games.quiz');
    expect(model.data).toMatchObject({ right: 0, asked: 1 });
  });

  it('says it cannot ask where there is no surface', async () => {
    const out = await builtin_quiz([]);
    expect(out.status).toBe('error');
    expect((out as { renderedErr: string }).renderedErr).toContain('cannot ask here');
  });
});

describe('hangman', () => {
  it('masks the word', () => {
    expect(word_mask('feed', new Set(['e']))).toBe('_ e e _');
    expect(HANGMAN_WORDS.every((w: string): boolean => /^[a-z]+$/.test(w))).toBe(true);
  });

  it('a word guessed whole wins; six misses hang', async () => {
    answers.push(...HANGMAN_WORDS);
    const won = await builtin_hangman([]);
    const model = won.model as { data: { won: boolean; word: string } };
    expect(model.data.won || plain(won.rendered).includes('hanged')).toBe(true);
    answers.length = 0;
    answers.push('zz', 'zz', 'zz', 'zz', 'zz', 'zz', 'zz');
    const lost = await builtin_hangman([]);
    expect(plain(lost.rendered)).toContain('hanged');
    expect((lost.model as { data: { misses: number } }).data.misses).toBe(6);
    answers.length = 0;
    answers.push('q');
    expect(plain((await builtin_hangman([])).rendered)).toMatch(/the word was [a-z]+/);
  });
});

describe('2048', () => {
  it('slides and merges a row once per pair', () => {
    expect(row_slide([2, 2, 0, 0])).toEqual({ row: [4, 0, 0, 0], score: 4 });
    expect(row_slide([2, 2, 2, 2])).toEqual({ row: [4, 4, 0, 0], score: 8 });
    expect(row_slide([4, 0, 4, 2])).toEqual({ row: [8, 2, 0, 0], score: 8 });
    expect(row_slide([0, 0, 0, 2])).toEqual({ row: [2, 0, 0, 0], score: 0 });
  });

  it('moves the board in four directions and knows when nothing moved', () => {
    const board = [[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    expect(board_move(board, 'up')).toMatchObject({ board: [[4, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 4, moved: true });
    expect(board_move(board, 'down').board[3]).toEqual([4, 0, 0, 0]);
    expect(board_move(board, 'right').board[0]).toEqual([0, 0, 0, 2]);
    expect(board_move(board, 'left').moved).toBe(false);
    const full = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
    expect(board_canMove(full)).toBe(false);
    expect(board_spawn(full)).toBe(false);
    const empty = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    expect(board_spawn(empty, () => 0)).toBe(true);
    expect(empty[0]?.[0]).toBe(4);  // a random of 0 picks the first cell and the one-in-ten 4
    expect(board_render(empty, 0)).toContain('score 0');
  });

  it('plays by answer and stops on q', async () => {
    answers.push('a', 'w', 'x', 'q');
    const out = await builtin_2048([]);
    expect(out.status).toBe('ok');
    expect(plain(out.rendered)).toMatch(/^final score \d+/);
    expect((out.model as { kind: string }).kind).toBe('games.2048');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
