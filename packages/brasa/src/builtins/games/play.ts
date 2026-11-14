/**
 * @file Games played by question and answer: `quiz`, `hangman`, `2048`.
 *
 * Each turn is a question the kernel asks the surface — the console in a
 * terminal, the console's ask bar in ARGUS — so the same game plays
 * anywhere a question can be answered. The boards and the scoring are pure
 * functions, tested apart from the asking.
 *
 * @module
 */
import chalk from 'chalk';
import { repl_question } from '../../core/question.js';
import { sink_dataLine } from '../../core/sink.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/* ---------------------------------------------------------------- quiz */

/** One question and its acceptable answers (matched without case or punctuation). */
export interface QuizItem { q: string; a: ReadonlyArray<string> }

/** The bank: the lab's own vocabulary. */
export const QUIZ_BANK: ReadonlyArray<QuizItem> = [
  { q: 'What does CUBE stand for?', a: ['chris ultron back end', 'chris ultron backend'] },
  { q: 'Which DICOM service asks a PACS what it holds: C-FIND, C-MOVE or C-STORE?', a: ['c-find', 'cfind', 'c find'] },
  { q: 'Which DICOM service tells a PACS to send a series?', a: ['c-move', 'cmove', 'c move'] },
  { q: 'What is the DICOM tag name for the hospital\'s patient identifier (the MRN)?', a: ['patientid', 'patient id'] },
  { q: 'Which service receives DICOM files for ChRIS and reports progress over LONK?', a: ['oxidicom'] },
  { q: 'Which service does `pull` go through to reach a PACS?', a: ['pfdcm'] },
  { q: 'A plugin that takes data in and gives data out is of which kind: fs, ds or ts?', a: ['ds'] },
  { q: 'A plugin that joins several parents is of which kind: fs, ds or ts?', a: ['ts'] },
  { q: 'What is one analysis in ChRIS called (a tree of plugin instances on some data)?', a: ['feed', 'a feed'] },
  { q: 'What does the K in LONK stand for? (spelling counts)', a: ['notifikations', 'notifications'] },
  { q: 'Which file format do most neuroimaging tools read: NIfTI or DICOM?', a: ['nifti'] },
  { q: 'In SeaGaP, what does the P stand for?', a: ['process'] },
  { q: 'What is the mise kernel package called?', a: ['brasa'] },
  { q: 'What is the mise daemon called?', a: ['calypso'] },
  { q: 'At 0 Hounsfield units, what are you looking at?', a: ['water'] },
];

/** How many a round asks. */
export const QUIZ_ROUND: number = 5;

/** Whether an answer matches: case, spaces and punctuation set aside. */
export function answer_matches(given: string, accepted: ReadonlyArray<string>): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const g: string = norm(given);
  return g.length > 0 && accepted.some((a: string): boolean => norm(a) === g);
}

/** `quiz` takes nothing. */
const QUIZ_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `quiz`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [quizCommand] });
 * ```
 */
export const quizCommand = command_declare({
  name: 'quiz',
  grammar: QUIZ_GRAMMAR,
  help: {
    summary: 'Five questions about the lab and its words',
    description: "Asks five questions from the lab's own book — CUBE, DICOM, plugins, the services — one at a time; answer, or q to stop. Plays anywhere a question can be answered: a terminal or the ARGUS console.",
    examples: ['quiz'],
  },
  handler: async (): Promise<CommandEnvelope> => quiz_run(),
});

/**
 * `quiz` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `quiz`: none.
 * @returns The game's end, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_quiz([]);
 * ```
 */
export async function builtin_quiz(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(quizCommand, args);
}

/**
 * Plays `quiz`: five questions from the bank, the score at the end.
 *
 * @returns The score.
 *
 * @example
 * ```ts
 * await quiz_run();
 * ```
 */
export async function quiz_run(): Promise<CommandEnvelope> {
  const asked: QuizItem[] = [...QUIZ_BANK].sort((): number => Math.random() - 0.5).slice(0, QUIZ_ROUND);
  let right: number = 0;
  const results: Array<{ q: string; right: boolean }> = [];
  try {
    for (const [i, item] of asked.entries()) {
      const answer: string = await repl_question(`${i + 1}/${asked.length}  ${item.q} `);
      if (answer.trim().toLowerCase() === 'q') break;
      const ok: boolean = answer_matches(answer, item.a);
      if (ok) right++;
      results.push({ q: item.q, right: ok });
      sink_dataLine(ok ? chalk.green('  right') : chalk.yellow(`  no — ${item.a[0]}`));
    }
  } catch (error: unknown) {
    return envelope_error('', undefined, `quiz: cannot ask here (${error instanceof Error ? error.message : String(error)})\n`);
  }
  const verdict: string = right === results.length && results.length === asked.length ? 'perfect' : right >= Math.ceil(results.length / 2) ? 'not bad' : 'wtf -l will help';
  return envelope_ok(`\n${right} of ${results.length} — ${verdict}\n`, { kind: 'games.quiz', data: { right, asked: results.length, results } });
}

/* ------------------------------------------------------------- hangman */

/** The words: the lab's. */
export const HANGMAN_WORDS: ReadonlyArray<string> = ['oxidicom', 'pipeline', 'dicom', 'cohort', 'feed', 'plugin', 'calypso', 'brasa', 'accession', 'series', 'modality', 'nifti', 'hounsfield', 'lonk', 'pfdcm', 'stardate'];

/** The gallows, by misses. */
export const GALLOWS: ReadonlyArray<ReadonlyArray<string>> = [
  ['  +---+', '  |   |', '      |', '      |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', '      |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', '  |   |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|   |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', ' /    |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', ' / \\  |', '      |', '========='],
];

/** The word with the letters not yet guessed hidden. */
export function word_mask(word: string, guessed: ReadonlySet<string>): string {
  return [...word].map((c: string): string => (guessed.has(c) ? c : '_')).join(' ');
}

/** `hangman` takes nothing. */
const HANGMAN_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `hangman`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [hangmanCommand] });
 * ```
 */
export const hangmanCommand = command_declare({
  name: 'hangman',
  grammar: HANGMAN_GRAMMAR,
  help: {
    summary: "Hangman, with the lab's words",
    description: 'A word from the lab, six misses allowed: a letter a turn, the whole word when you know it, q to give up.',
    examples: ['hangman'],
  },
  handler: async (): Promise<CommandEnvelope> => hangman_run(),
});

/**
 * `hangman` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `hangman`: none.
 * @returns The game's end, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_hangman([]);
 * ```
 */
export async function builtin_hangman(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(hangmanCommand, args);
}

/**
 * Plays `hangman`: a word from the lab, six misses allowed.
 *
 * @returns How it ended.
 *
 * @example
 * ```ts
 * await hangman_run();
 * ```
 */
export async function hangman_run(): Promise<CommandEnvelope> {
  const word: string = HANGMAN_WORDS[Math.floor(Math.random() * HANGMAN_WORDS.length)] as string;
  const guessed: Set<string> = new Set();
  let misses: number = 0;
  try {
    while (misses < GALLOWS.length - 1) {
      const mask: string = word_mask(word, guessed);
      if (!mask.includes('_')) break;
      sink_dataLine(`${(GALLOWS[misses] as ReadonlyArray<string>).join('\n')}\n\n  ${mask}    missed: ${[...guessed].filter((c: string): boolean => !word.includes(c)).join(' ') || '—'}`);
      const answer: string = (await repl_question('letter (or the word, or q): ')).trim().toLowerCase();
      if (answer === 'q') return envelope_ok(`\nthe word was ${word}\n`, { kind: 'games.hangman', data: { word, won: false, quit: true } });
      if (answer.length > 1) {
        if (answer === word) { for (const c of word) guessed.add(c); break; }
        misses++; continue;
      }
      if (!/^[a-z]$/.test(answer) || guessed.has(answer)) continue;
      guessed.add(answer);
      if (!word.includes(answer)) misses++;
    }
  } catch (error: unknown) {
    return envelope_error('', undefined, `hangman: cannot ask here (${error instanceof Error ? error.message : String(error)})\n`);
  }
  const won: boolean = !word_mask(word, guessed).includes('_');
  const end: string = won ? chalk.green(`\n  ${word} — saved, with ${misses} miss${misses === 1 ? '' : 'es'}\n`) : `${(GALLOWS[GALLOWS.length - 1] as ReadonlyArray<string>).join('\n')}\n\n  ${chalk.red('hanged')} — the word was ${word}\n`;
  return envelope_ok(end, { kind: 'games.hangman', data: { word, won, misses } });
}

/* ---------------------------------------------------------------- 2048 */

/** A 4×4 board, 0 for empty. */
export type Board = number[][];

/** Slides and merges one row to the left; returns the row and the points scored. */
export function row_slide(row: number[]): { row: number[]; score: number } {
  const tiles: number[] = row.filter((v: number): boolean => v !== 0);
  const out: number[] = [];
  let score: number = 0;
  for (let i: number = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) { out.push((tiles[i] as number) * 2); score += (tiles[i] as number) * 2; i++; }
    else out.push(tiles[i] as number);
  }
  while (out.length < row.length) out.push(0);
  return { row: out, score };
}

/** Moves the whole board; returns the new board, the points, and whether anything moved. */
export function board_move(board: Board, direction: 'left' | 'right' | 'up' | 'down'): { board: Board; score: number; moved: boolean } {
  const n: number = board.length;
  const get = (r: number, c: number): number => {
    if (direction === 'left') return (board[r] as number[])[c] as number;
    if (direction === 'right') return (board[r] as number[])[n - 1 - c] as number;
    if (direction === 'up') return (board[c] as number[])[r] as number;
    return (board[n - 1 - c] as number[])[r] as number;
  };
  const next: Board = board.map((row: number[]): number[] => [...row]);
  let score: number = 0; let moved: boolean = false;
  for (let r: number = 0; r < n; r++) {
    const line: number[] = Array.from({ length: n }, (_: unknown, c: number): number => get(r, c));
    const slid = row_slide(line);
    score += slid.score;
    for (let c: number = 0; c < n; c++) {
      const v: number = slid.row[c] as number;
      if (v !== line[c]) moved = true;
      if (direction === 'left') (next[r] as number[])[c] = v;
      else if (direction === 'right') (next[r] as number[])[n - 1 - c] = v;
      else if (direction === 'up') (next[c] as number[])[r] = v;
      else (next[n - 1 - c] as number[])[r] = v;
    }
  }
  return { board: next, score, moved };
}

/** Puts a 2 (or, one time in ten, a 4) on an empty cell; false when there is none. */
export function board_spawn(board: Board, random: () => number = Math.random): boolean {
  const empty: Array<[number, number]> = [];
  board.forEach((row: number[], r: number): void => row.forEach((v: number, c: number): void => { if (v === 0) empty.push([r, c]); }));
  if (empty.length === 0) return false;
  const [r, c] = empty[Math.floor(random() * empty.length)] as [number, number];
  (board[r] as number[])[c] = random() < 0.1 ? 4 : 2;
  return true;
}

/** Whether any move is left. */
export function board_canMove(board: Board): boolean {
  return (['left', 'right', 'up', 'down'] as const).some((d): boolean => board_move(board, d).moved);
}

/** The board drawn. */
export function board_render(board: Board, score: number): string {
  const cell = (v: number): string => (v === 0 ? '    .' : String(v).padStart(5));
  return `${board.map((row: number[]): string => row.map(cell).join('')).join('\n')}\n  score ${score}`;
}

/** `2048` takes nothing. */
const GAME2048_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `2048`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [game2048Command] });
 * ```
 */
export const game2048Command = command_declare({
  name: '2048',
  grammar: GAME2048_GRAMMAR,
  help: {
    summary: 'Slide the tiles, join the powers of two',
    description: 'The 4×4 board, a move per answer: w a s d (or h j k l) slide, q stops. Two tiles alike join; reach 2048.',
    examples: ['2048'],
  },
  handler: async (): Promise<CommandEnvelope> => game2048_run(),
});

/**
 * `2048` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `2048`: none.
 * @returns The game's end, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_2048([]);
 * ```
 */
export async function builtin_2048(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(game2048Command, args);
}

/**
 * Plays `2048`: w/a/s/d (or h/j/k/l) by question, q to stop.
 *
 * @returns The final score.
 *
 * @example
 * ```ts
 * await game2048_run();
 * ```
 */
export async function game2048_run(): Promise<CommandEnvelope> {
  let board: Board = Array.from({ length: 4 }, (): number[] => [0, 0, 0, 0]);
  board_spawn(board); board_spawn(board);
  let score: number = 0;
  const keys: Record<string, 'left' | 'right' | 'up' | 'down'> = { a: 'left', h: 'left', d: 'right', l: 'right', w: 'up', k: 'up', s: 'down', j: 'down' };
  try {
    for (;;) {
      sink_dataLine(board_render(board, score));
      if (board.some((row: number[]): boolean => row.includes(2048))) { sink_dataLine(chalk.green('  2048 — you have it')); break; }
      if (!board_canMove(board)) { sink_dataLine(chalk.yellow('  no move left')); break; }
      const answer: string = (await repl_question('move (w a s d, q to stop): ')).trim().toLowerCase();
      if (answer === 'q') break;
      const direction = keys[answer[0] ?? ''];
      if (direction === undefined) continue;
      const moved = board_move(board, direction);
      if (!moved.moved) continue;
      board = moved.board; score += moved.score;
      board_spawn(board);
    }
  } catch (error: unknown) {
    return envelope_error('', undefined, `2048: cannot ask here (${error instanceof Error ? error.message : String(error)})\n`);
  }
  return envelope_ok(`final score ${score}\n`, { kind: 'games.2048', data: { board, score } });
}
