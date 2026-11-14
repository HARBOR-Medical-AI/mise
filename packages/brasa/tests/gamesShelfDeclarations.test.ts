/**
 * @file The games shelf's commands, declared in one record each: the sky
 * (`pom`, `stardate`, `ddate`, `sunrise`), the chimes (`timer`, `leave`,
 * `stopwatch`), the showpieces and arcade, the question games, `trek`, the
 * lab's toys, the ChRIS lab's `ping` and `chrisfetch`, the byte tools and
 * `motd`. Each parses its line against its grammar with core kinds, refuses
 * a bad one before its handler runs, and holds what it did before.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

// The commands are only parsed here: what they reach (CUBE, the file reader, the index) is stood in for.
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  chrisContext: { ChRISURL_get: async (): Promise<string | null> => null, ChRISuser_get: async (): Promise<string | null> => null },
  requestLedger_snapshot: () => ({ since: '', total: 0, ms: 0, families: [], last: [] }),
  errorStack: { stack_pop: () => undefined, stack_push: () => undefined },
  procCache_get: () => ({}),
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({ files_catBinary: jest.fn(), files_cat: jest.fn() }));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: async (p: string): Promise<string> => p, error_stripDebugPrefix: (s: string): string => s }));
jest.unstable_mockModule('../src/chris/jobsState.js', () => ({ jobsState_derive: () => ({ running: 0, scheduled: 0 }) }));
jest.unstable_mockModule('../src/builtins/sys/fortune.js', () => ({ fortune_random: () => '' }));

const { declaration_isParsed } = await import('../src/core/commandDeclaration.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { CORE_KIND_NAMES } = await import('../src/core/argumentKinds.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');
const { pomCommand, stardateCommand, ddateCommand, sunriseCommand } = await import('../src/builtins/games/sky.js');
const { timerCommand, leaveCommand, stopwatchCommand } = await import('../src/builtins/games/chimes.js');
const { slCommand, cmatrixCommand, rainCommand, asciiquariumCommand, tetrisCommand, snakeCommand } = await import('../src/builtins/games/show.js');
const { game2048Command, hangmanCommand, quizCommand } = await import('../src/builtins/games/play.js');
const { trekCommand } = await import('../src/builtins/games/trek.js');
const { whoCommand, uptimeCommand, sayCommand } = await import('../src/builtins/games/lab.js');
const { pingCommand, chrisfetchCommand } = await import('../src/builtins/games/chrislab.js');
const { xxdCommand, stringsCommand, sha256sumCommand, md5sumCommand } = await import('../src/builtins/games/bytes.js');
const { motdCommand } = await import('../src/builtins/sys/motd.js');

type Parsed = Awaited<ReturnType<typeof commandLine_parse>>;
type Parsable = Parameters<typeof commandLine_parse>[0];

/** The games shelf's commands, each declared. */
const SHELF: Parsable[] = [
  pomCommand, stardateCommand, ddateCommand, sunriseCommand,
  timerCommand, leaveCommand, stopwatchCommand,
  slCommand, cmatrixCommand, rainCommand, asciiquariumCommand, tetrisCommand, snakeCommand,
  game2048Command, hangmanCommand, quizCommand,
  trekCommand,
  whoCommand, uptimeCommand, sayCommand,
  pingCommand, chrisfetchCommand,
  xxdCommand, stringsCommand, sha256sumCommand, md5sumCommand,
  motdCommand,
] as Parsable[];

/**
 * Parses a line's words against a declaration.
 *
 * @param declaration - The command.
 * @param line - The words after the command, as typed.
 * @returns The parse.
 */
async function line_parse(declaration: Parsable, line: string): Promise<Parsed> {
  return commandLine_parse(declaration, shellWords_tokenize(line));
}

/**
 * What a good line parses to: its subcommand, operands and options.
 *
 * @param declaration - The command.
 * @param line - The words after the command.
 * @returns The typed object, or the refusal's words.
 */
async function typed_get(declaration: Parsable, line: string): Promise<unknown> {
  const parsed: Parsed = await line_parse(declaration, line);
  return parsed.ok ? { subcommand: parsed.args.subcommand, operands: parsed.args.operands, options: parsed.args.options } : parsed.refusal;
}

/**
 * The refusal of a line, or a failure when it parses.
 *
 * @param declaration - The command.
 * @param line - The words after the command.
 * @returns The refusal.
 */
async function refusal_get(declaration: Parsable, line: string): Promise<string> {
  const parsed: Parsed = await line_parse(declaration, line);
  if (parsed.ok) throw new Error(`expected a refusal for: ${line}`);
  return parsed.refusal;
}

beforeEach(() => {
  process.exitCode = 0;
});

describe('the games shelf is declared', () => {
  it('each command once, parsed against a grammar of core kinds', () => {
    expect(new Set(SHELF.map((declaration) => declaration.name)).size).toBe(27);
    for (const declaration of SHELF) {
      expect(declaration_isParsed(declaration)).toBe(true);
      const lines = [declaration.grammar, ...Object.values(declaration.grammar.subcommands ?? {})];
      const kinds: string[] = lines.flatMap((line) => [
        ...(line.operands ?? []).map((operand) => operand.kind),
        ...Object.values(line.options ?? {}).flatMap((option) => (option.value === undefined ? [] : [option.value.kind])),
      ]);
      for (const kind of kinds) expect(CORE_KIND_NAMES).toContain(kind);
    }
  });

  it('the reads hold nothing and the games hold the whole session', () => {
    const none: string[] = ['pom', 'stardate', 'ddate', 'who', 'uptime', 'xxd', 'strings', 'sha256sum', 'md5sum', 'motd'];
    for (const declaration of SHELF) {
      if (none.includes(declaration.name)) expect(declaration.holds).toEqual([]);
      else expect(declaration.holds).toBeUndefined();
    }
  });

  it('writes each usage line from its grammar', () => {
    const usage = (declaration: Parsable): string => commandUsage_render(declaration);
    expect(usage(pomCommand)).toBe('pom [date…]');
    expect(usage(slCommand)).toBe('sl [--pane]');
    expect(usage(xxdCommand)).toBe('xxd [-s <OFFSET>] [-l <LENGTH>] <path>');
    expect(usage(sha256sumCommand)).toBe('sha256sum <paths…>');
  });
});

describe('the sky', () => {
  it('reads a date in as many words as it is written', async () => {
    expect(await typed_get(pomCommand, '')).toEqual({ subcommand: null, operands: { date: [] }, options: {} });
    expect(await typed_get(pomCommand, '2026-12-25')).toEqual({ subcommand: null, operands: { date: ['2026-12-25'] }, options: {} });
    expect(await typed_get(stardateCommand, 'Jan 1 2366')).toEqual({ subcommand: null, operands: { date: ['Jan', '1', '2366'] }, options: {} });
    expect(await typed_get(ddateCommand, '2028-02-29')).toEqual({ subcommand: null, operands: { date: ['2028-02-29'] }, options: {} });
    expect(await refusal_get(pomCommand, '-x')).toMatch(/pom: invalid option -- 'x'/);
    expect(await refusal_get(ddateCommand, '--when')).toMatch(/ddate: unrecognized option '--when'/);
  });

  it('reads a place in as many words as it is named', async () => {
    expect(await typed_get(sunriseCommand, 'Cape Town')).toEqual({ subcommand: null, operands: { place: ['Cape', 'Town'] }, options: {} });
    expect(await typed_get(sunriseCommand, '')).toEqual({ subcommand: null, operands: { place: [] }, options: {} });
    expect(await refusal_get(sunriseCommand, '--units')).toMatch(/sunrise: unrecognized option '--units'/);
  });
});

describe('the chimes', () => {
  it('timer takes a duration and words, or cancel', async () => {
    expect(await typed_get(timerCommand, '')).toEqual({ subcommand: null, operands: { duration: undefined, words: [] }, options: {} });
    expect(await typed_get(timerCommand, '5m tea is ready')).toEqual({ subcommand: null, operands: { duration: '5m', words: ['tea', 'is', 'ready'] }, options: {} });
    expect(await typed_get(timerCommand, 'cancel 2')).toEqual({ subcommand: 'cancel', operands: { which: '2' }, options: {} });
    expect(await typed_get(timerCommand, 'cancel')).toEqual({ subcommand: 'cancel', operands: { which: undefined }, options: {} });
    expect(await refusal_get(timerCommand, '--loud 5m')).toMatch(/timer: unrecognized option '--loud'/);
    expect(await refusal_get(timerCommand, 'cancel 1 2')).toMatch(/unexpected operand '2'/);
  });

  it('leave takes a time, or cancel', async () => {
    expect(await typed_get(leaveCommand, '+0030')).toEqual({ subcommand: null, operands: { time: '+0030' }, options: {} });
    expect(await typed_get(leaveCommand, '')).toEqual({ subcommand: null, operands: { time: undefined }, options: {} });
    expect(await typed_get(leaveCommand, 'cancel')).toEqual({ subcommand: 'cancel', operands: {}, options: {} });
    expect(await refusal_get(leaveCommand, '1730 1800')).toMatch(/unexpected operand '1800'/);
  });

  it('stopwatch takes one of its four words, or none', async () => {
    for (const word of ['start', 'stop', 'lap', 'reset']) expect(await typed_get(stopwatchCommand, word)).toEqual({ subcommand: word, operands: {}, options: {} });
    expect(await typed_get(stopwatchCommand, '')).toEqual({ subcommand: null, operands: {}, options: {} });
    expect(await refusal_get(stopwatchCommand, 'pause')).toMatch(/stopwatch: unknown subcommand 'pause' \(start, stop, lap, reset\)/);
  });
});

describe('the showpieces and the arcade', () => {
  it('each takes --pane and nothing else', async () => {
    for (const declaration of [slCommand, cmatrixCommand, rainCommand, asciiquariumCommand, tetrisCommand, snakeCommand]) {
      expect(await typed_get(declaration, '')).toEqual({ subcommand: null, operands: {}, options: { pane: false } });
      expect(await typed_get(declaration, '--pane')).toEqual({ subcommand: null, operands: {}, options: { pane: true } });
      expect(await refusal_get(declaration, '-x')).toMatch(/invalid option -- 'x'/);
      expect(await refusal_get(declaration, 'fast')).toMatch(/unexpected operand 'fast'/);
    }
  });
});

describe('the question games', () => {
  it('take nothing', async () => {
    for (const declaration of [game2048Command, hangmanCommand, quizCommand]) {
      expect(await typed_get(declaration, '')).toEqual({ subcommand: null, operands: {}, options: {} });
      expect(await refusal_get(declaration, 'hard')).toMatch(/unexpected operand 'hard'/);
    }
  });
});

describe('trek', () => {
  it('reads its look, its pace, its seed and its credits', async () => {
    expect(await typed_get(trekCommand, '')).toEqual({ subcommand: null, operands: {}, options: { classic: false, fast: false, slow: false, seed: undefined, credits: false } });
    expect(await typed_get(trekCommand, '--classic -f --seed 42')).toEqual({ subcommand: null, operands: {}, options: { classic: true, fast: true, slow: false, seed: 42, credits: false } });
    expect(await typed_get(trekCommand, '-s --credits')).toEqual({ subcommand: null, operands: {}, options: { classic: false, fast: false, slow: true, seed: undefined, credits: true } });
  });

  it('refuses a flag it does not know, a seed that is not a number, a stray word', async () => {
    expect(await refusal_get(trekCommand, '--warp')).toMatch(/trek: unrecognized option '--warp'; usage: trek/);
    expect(await refusal_get(trekCommand, '--seed many')).toMatch(/invalid argument 'many' for '--seed'/);
    expect(await refusal_get(trekCommand, 'extra')).toMatch(/unexpected operand 'extra'/);
  });
});

describe('the lab', () => {
  it('who and uptime take nothing; say takes words', async () => {
    expect(await typed_get(whoCommand, '')).toEqual({ subcommand: null, operands: {}, options: {} });
    expect(await typed_get(uptimeCommand, '')).toEqual({ subcommand: null, operands: {}, options: {} });
    expect(await typed_get(sayCommand, 'analysis complete')).toEqual({ subcommand: null, operands: { text: ['analysis', 'complete'] }, options: {} });
    expect(await typed_get(sayCommand, '')).toEqual({ subcommand: null, operands: { text: [] }, options: {} });
    expect(await typed_get(sayCommand, '-- -5 degrees')).toEqual({ subcommand: null, operands: { text: ['-5', 'degrees'] }, options: {} });
    expect(await refusal_get(whoCommand, 'am')).toMatch(/unexpected operand 'am'/);
    expect(await refusal_get(uptimeCommand, '-p')).toMatch(/invalid option -- 'p'/);
    expect(await refusal_get(sayCommand, '-x')).toMatch(/invalid option -- 'x'/);
  });
});

describe('the ChRIS lab', () => {
  it('ping reads a count and the one place it pings', async () => {
    expect(await typed_get(pingCommand, '')).toEqual({ subcommand: null, operands: { target: undefined }, options: { count: undefined } });
    expect(await typed_get(pingCommand, '-c 10 cube')).toEqual({ subcommand: null, operands: { target: 'cube' }, options: { count: 10 } });
    expect(await refusal_get(pingCommand, '-c 0')).toMatch(/invalid argument '0' for '-c'/);
    expect(await refusal_get(pingCommand, '-c many')).toMatch(/invalid argument 'many' for '-c'/);
    expect(await refusal_get(pingCommand, 'pacs')).toMatch(/invalid argument 'pacs' for <target>/);
  });

  it('chrisfetch takes nothing', async () => {
    expect(await typed_get(chrisfetchCommand, '')).toEqual({ subcommand: null, operands: {}, options: {} });
    expect(await refusal_get(chrisfetchCommand, '--all')).toMatch(/unrecognized option '--all'/);
  });
});

describe('the byte tools', () => {
  it('xxd reads a file, where to start and how much', async () => {
    expect(await typed_get(xxdCommand, 'a.dcm')).toEqual({ subcommand: null, operands: { path: 'a.dcm' }, options: { offset: undefined, length: undefined } });
    expect(await typed_get(xxdCommand, '-s 128 -l 16 a.dcm')).toEqual({ subcommand: null, operands: { path: 'a.dcm' }, options: { offset: 128, length: 16 } });
    expect(await refusal_get(xxdCommand, '-l -4 a.dcm')).toMatch(/invalid argument '-4' for '-l'/);
    expect(await refusal_get(xxdCommand, '-l 16')).toMatch(/missing operand <path>/);
    expect(await refusal_get(xxdCommand, 'a b')).toMatch(/unexpected operand 'b'/);
  });

  it('strings reads a file, the shortest run and how many to show', async () => {
    expect(await typed_get(stringsCommand, '-n 8 -l 20 a.bin')).toEqual({ subcommand: null, operands: { path: 'a.bin' }, options: { min: 8, limit: 20 } });
    expect(await refusal_get(stringsCommand, '-n many a.bin')).toMatch(/invalid argument 'many' for '-n'/);
    expect(await refusal_get(stringsCommand, '')).toMatch(/missing operand <path>/);
  });

  it('the digests read files', async () => {
    expect(await typed_get(sha256sumCommand, 'a.txt b.txt')).toEqual({ subcommand: null, operands: { paths: ['a.txt', 'b.txt'] }, options: {} });
    expect(await typed_get(md5sumCommand, 'a.txt')).toEqual({ subcommand: null, operands: { paths: ['a.txt'] }, options: {} });
    expect(await refusal_get(sha256sumCommand, '')).toMatch(/missing operand <paths>/);
    expect(await refusal_get(md5sumCommand, '-c a.txt')).toMatch(/md5sum: invalid option -- 'c'/);
  });
});

describe('motd', () => {
  it('reads where the operator arrived, and refuses a flag', async () => {
    expect(await typed_get(motdCommand, 'ARGUS')).toEqual({ subcommand: null, operands: { surface: ['ARGUS'] }, options: {} });
    expect(await typed_get(motdCommand, '')).toEqual({ subcommand: null, operands: { surface: [] }, options: {} });
    expect(await refusal_get(motdCommand, '--brief')).toMatch(/motd: unrecognized option '--brief'/);
  });
});
