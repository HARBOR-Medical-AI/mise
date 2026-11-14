/**
 * @file The showpieces — `sl`, `cmatrix`, `rain`, `asciiquarium` — and the
 * arcade: `tetris`, `snake`.
 *
 * Each is a program on a cell grid (`@fnndsc/menu/games`). A terminal
 * plays it in place: chell takes the screen on the `games.show` model, and
 * gives it back on q, Esc or Ctrl-C. `--pane` asks ARGUS to draw it in its
 * GAMES pane instead, as the deprecated transcript console always does.
 * Every surface also gets the text: a still of the show, and how to play it.
 *
 * @module
 */
import chalk from 'chalk';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandDeclaration, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** The programs a GAMES pane can run. */
export type ShowProgram = 'sl' | 'cmatrix' | 'rain' | 'aquarium' | 'tetris' | 'snake';

/**
 * The starship `sl` sends across the screen (a typo's punishment, as the
 * train was): the Constitution-class refit, side view, from the Star Trek
 * ASCII Art blog (startrekasciiart.blogspot.com, "Constitution Class -
 * Refit", 2011; artist uncredited there; re-use granted with attribution
 * retained). Nose to the right: it flies left to right.
 */
export const STARSHIP: ReadonlyArray<string> = [
  '___________________          _-_         ',
  '\\__(==========/_=_/ ____.---\'---`---.____',
  '            \\_ \\    \\----._________.----/',
  '              \\ \\   /  /    `-_-\'        ',
  '          __,--`.`-\'..\'-_                ',
  '         /____          ||               ',
  '              `--.____,-\'                ',
];

/** The glyphs `cmatrix` rains. */
export const MATRIX_GLYPHS: string = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ0123456789Z:・.=*+-<>¦|';

/** A still of a show, for a console with no canvas. */
export function still_render(program: ShowProgram, random: () => number = Math.random): string[] {
  const pick = (s: string): string => s[Math.floor(random() * s.length)] as string;
  switch (program) {
    case 'sl': return [...STARSHIP];
    case 'cmatrix': return Array.from({ length: 6 }, (): string => Array.from({ length: 40 }, (): string => (random() < 0.35 ? pick(MATRIX_GLYPHS) : ' ')).join(''));
    case 'rain': return Array.from({ length: 5 }, (_: unknown, row: number): string => Array.from({ length: 40 }, (): string => (random() < 0.12 ? (row === 4 ? 'o' : '|') : ' ')).join(''));
    case 'aquarium': return [
      '  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      '        ><>           o              ',
      '                 <><      o          ',
      '    ><>                        ><>   ',
      '  )(   )(      )(        )(   )(  )( ',
      '  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
    ];
    case 'tetris': return [
      '  |          |', '  |    ##    |', '  |   ##     |', '  |          |', '  |  # #  ## |', '  | ####  ###|', '  +----------+',
    ];
    case 'snake': return ['  . . . . . . . .', '  . @ o o o . . .', '  . . . . o . . .', '  . . * . . . . .'];
  }
}

/** What the console says beside a still: how the moving one is played. */
function note_render(program: ShowProgram, arcade: boolean, pane: boolean): string {
  if (pane) return chalk.gray(`${program}: ARGUS draws it in its GAMES pane${arcade ? ' with the keys live (arrows; Esc gives the keyboard back)' : ''}.`);
  return chalk.gray(`${program}: a terminal plays it in place${arcade ? ' (arrows steer)' : ''}; q, Esc or Ctrl-C leaves. --pane draws it in ARGUS's GAMES pane.`);
}

/** What a showpiece's line may hold: the one switch that sends it to ARGUS's GAMES pane. */
const SHOW_GRAMMAR = {
  options: {
    pane: { long: 'pane', summary: "Draw it in ARGUS's GAMES pane instead of the terminal" },
  },
} as const satisfies CommandGrammar;

/**
 * Declares a showpiece: one program on the cell grid, with the one `--pane` switch.
 *
 * @param name - The word that runs it.
 * @param program - The program a GAMES pane runs.
 * @param arcade - Whether the keys play it (an arcade game) or it only shows.
 * @param prose - Its summary, description and examples.
 * @returns The declaration.
 *
 * @example
 * ```ts
 * export const slCommand = showCommand_make('sl', 'sl', false, { summary: 'A starship crosses the screen', description: '…', examples: ['sl'] });
 * ```
 */
function showCommand_make(name: string, program: ShowProgram, arcade: boolean, prose: { summary: string; description: string; examples: readonly string[] }): CommandDeclaration<typeof SHOW_GRAMMAR> {
  return command_declare({
    name,
    grammar: SHOW_GRAMMAR,
    help: prose,
    handler: async (args: CommandArguments<typeof SHOW_GRAMMAR>): Promise<CommandEnvelope> => show_run(program, arcade, args.options.pane),
  });
}

/**
 * Runs a showpiece: a still of it, and how the moving one is played.
 *
 * @param program - The program.
 * @param arcade - Whether the keys play it.
 * @param pane - Whether ARGUS's GAMES pane draws it.
 * @returns The still and the note, on the `games.show` model.
 *
 * @example
 * ```ts
 * show_run('sl', false, true);
 * ```
 */
function show_run(program: ShowProgram, arcade: boolean, pane: boolean): CommandEnvelope {
  const still: string[] = still_render(program);
  return envelope_ok(`${still.join('\n')}\n${note_render(program, arcade, pane)}\n`, { kind: 'games.show', data: { program, args: [], arcade, pane } });
}

/**
 * `sl [--pane]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [slCommand] });
 * ```
 */
export const slCommand: CommandDeclaration<typeof SHOW_GRAMMAR> = showCommand_make('sl', 'sl', false, {
  summary: 'A starship crosses the screen (the punishment for mistyping ls)',
  description: "The train of old, refitted: a starship glides across the terminal. q, Esc or Ctrl-C gives the screen back. --pane draws it in ARGUS's GAMES pane instead (the transcript console always does).",
  examples: ['sl', 'sl --pane'],
});

/**
 * `sl` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `sl`.
 * @returns The show, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_sl(['--pane']);
 * ```
 */
export async function builtin_sl(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(slCommand, args);
}

/**
 * `cmatrix [--pane]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [cmatrixCommand] });
 * ```
 */
export const cmatrixCommand: CommandDeclaration<typeof SHOW_GRAMMAR> = showCommand_make('cmatrix', 'cmatrix', false, {
  summary: 'The glyph rain',
  description: "Columns of glyphs falling down the terminal. q, Esc or Ctrl-C gives the screen back. --pane draws it in ARGUS's GAMES pane instead (the transcript console always does).",
  examples: ['cmatrix', 'cmatrix --pane'],
});

/**
 * `cmatrix` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `cmatrix`.
 * @returns The show, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_cmatrix(['--pane']);
 * ```
 */
export async function builtin_cmatrix(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(cmatrixCommand, args);
}

/**
 * `rain [--pane]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [rainCommand] });
 * ```
 */
export const rainCommand: CommandDeclaration<typeof SHOW_GRAMMAR> = showCommand_make('rain', 'rain', false, {
  summary: 'Rain',
  description: "Drops falling and ringing out on the floor of the terminal. q, Esc or Ctrl-C gives the screen back. --pane draws it in ARGUS's GAMES pane instead (the transcript console always does).",
  examples: ['rain'],
});

/**
 * `rain` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `rain`.
 * @returns The show, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_rain(['--pane']);
 * ```
 */
export async function builtin_rain(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(rainCommand, args);
}

/**
 * `asciiquarium [--pane]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [asciiquariumCommand] });
 * ```
 */
export const asciiquariumCommand: CommandDeclaration<typeof SHOW_GRAMMAR> = showCommand_make('asciiquarium', 'aquarium', false, {
  summary: 'An aquarium: fish, weed, bubbles',
  description: "Fish swimming both ways, weed swaying, bubbles rising, in the terminal. q, Esc or Ctrl-C gives the screen back. --pane draws it in ARGUS's GAMES pane instead (the transcript console always does).",
  examples: ['asciiquarium'],
});

/**
 * `asciiquarium` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `asciiquarium`.
 * @returns The show, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_asciiquarium(['--pane']);
 * ```
 */
export async function builtin_asciiquarium(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(asciiquariumCommand, args);
}

/**
 * `tetris [--pane]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [tetrisCommand] });
 * ```
 */
export const tetrisCommand: CommandDeclaration<typeof SHOW_GRAMMAR> = showCommand_make('tetris', 'tetris', true, {
  summary: 'Falling blocks',
  description: "Played in the terminal: left/right move, up rotates, down drops. q, Esc or Ctrl-C gives the screen back. --pane draws it in ARGUS's GAMES pane instead (the transcript console always does).",
  examples: ['tetris', 'tetris --pane'],
});

/**
 * `tetris` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `tetris`.
 * @returns The show, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_tetris(['--pane']);
 * ```
 */
export async function builtin_tetris(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(tetrisCommand, args);
}

/**
 * `snake [--pane]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [snakeCommand] });
 * ```
 */
export const snakeCommand: CommandDeclaration<typeof SHOW_GRAMMAR> = showCommand_make('snake', 'snake', true, {
  summary: 'The snake',
  description: "Played in the terminal: arrows (or hjkl, wasd) steer; eat the food, do not eat yourself. q, Esc or Ctrl-C gives the screen back. --pane draws it in ARGUS's GAMES pane instead (the transcript console always does).",
  examples: ['snake'],
});

/**
 * `snake` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `snake`.
 * @returns The show, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_snake(['--pane']);
 * ```
 */
export async function builtin_snake(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(snakeCommand, args);
}
