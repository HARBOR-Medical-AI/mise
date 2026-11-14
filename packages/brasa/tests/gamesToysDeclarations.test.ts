/**
 * @file The games shelf's toys, declared in one record each: each parses its
 * line against core kinds and refuses a bad one before its handler runs;
 * `calc` and `morse` take their words as they come, since an expression and
 * Morse code begin with dashes; the commands that hold nothing hold `[]`.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

const { declaration_isParsed } = await import('../src/core/commandDeclaration.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { CORE_KIND_NAMES } = await import('../src/core/argumentKinds.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');
const { revCommand, tacCommand, yesCommand, seqCommand, shufCommand, rot13Command } = await import('../src/builtins/games/text.js');
const { factorCommand, primesCommand, rollCommand, calcCommand, unitsCommand, builtin_calc, builtin_units } = await import('../src/builtins/games/numbers.js');
const { cowsayCommand, cowthinkCommand } = await import('../src/builtins/games/cowsay.js');
const { figletCommand, bannerCommand } = await import('../src/builtins/games/figlet.js');
const { lolcatCommand } = await import('../src/builtins/games/lolcat.js');
const { morseCommand, builtin_morse } = await import('../src/builtins/games/morse.js');
const { wtfCommand } = await import('../src/builtins/games/wtf.js');
const { qrCommand } = await import('../src/builtins/games/qr.js');
const { fortuneCommand } = await import('../src/builtins/sys/fortune.js');
const { calCommand } = await import('../src/builtins/sys/cal.js');
const { weatherCommand } = await import('../src/builtins/sys/weather.js');

type Parsed = Awaited<ReturnType<typeof commandLine_parse>>;
type Parsable = Parameters<typeof commandLine_parse>[0];

/** The toys, each declared. */
const TOYS = [
  revCommand, tacCommand, yesCommand, seqCommand, shufCommand, rot13Command,
  factorCommand, primesCommand, rollCommand, calcCommand, unitsCommand,
  cowsayCommand, cowthinkCommand, figletCommand, bannerCommand, lolcatCommand,
  morseCommand, wtfCommand, qrCommand, fortuneCommand, calCommand, weatherCommand,
];

/** The toys parsed against a grammar (all but calc and morse). */
const PARSED: Parsable[] = TOYS.filter(declaration_isParsed);

/** The toys that hold nothing of the session: the rest hold it whole. */
const HOLDING_NOTHING: string[] = [
  'rev', 'tac', 'seq', 'rot13', 'factor', 'primes', 'calc', 'units', 'cowsay', 'cowthink', 'figlet', 'banner',
  'lolcat', 'morse', 'qr', 'fortune', 'cal',
];

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
 * What a good line parsed to: its operands and options, or its refusal.
 *
 * @param declaration - The command.
 * @param line - The words after the command.
 * @returns The typed line, or the refusal's words.
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

describe('the toys are declared', () => {
  it('each once, with core kinds only', () => {
    expect(new Set(TOYS.map((toy) => toy.name)).size).toBe(TOYS.length);
    expect(TOYS.length).toBe(22);
    for (const declaration of PARSED) {
      const lines = [declaration.grammar, ...Object.values(declaration.grammar.subcommands ?? {})];
      const kinds: string[] = lines.flatMap((line) => [
        ...(line.operands ?? []).map((operand) => operand.kind),
        ...Object.values(line.options ?? {}).flatMap((option) => (option.value === undefined ? [] : [option.value.kind])),
      ]);
      for (const kind of kinds) expect(CORE_KIND_NAMES).toContain(kind);
    }
  });

  it('parses its line against a grammar, but for calc and morse, whose words are their own', () => {
    expect(TOYS.filter((one) => !declaration_isParsed(one)).map((one) => one.name)).toEqual(['calc', 'morse']);
  });

  it('holds nothing of the session where it only reads or draws, and the whole of it otherwise', () => {
    for (const toy of TOYS) {
      expect(toy.holds).toEqual(HOLDING_NOTHING.includes(toy.name) ? [] : undefined);
    }
  });

  it('names no category but where it had one: the games shelf supplies Games', () => {
    expect(TOYS.filter((toy) => toy.help.category !== undefined).map((toy) => toy.name)).toEqual(['fortune', 'cal', 'weather']);
    for (const name of ['fortune', 'cal', 'weather']) expect(TOYS.find((toy) => toy.name === name)?.help.category).toBe('Games');
  });
});

describe('usage, generated from the grammar', () => {
  it('writes each parsed toy\'s usage line', () => {
    expect(PARSED.map((declaration) => commandUsage_render(declaration))).toEqual([
      'rev [text…]',
      'tac [text…]',
      'yes [-n <N>] [words…]',
      'seq <numbers…>',
      'shuf [words…]',
      'rot13 [text…]',
      'factor [numbers…]',
      'primes <numbers…>',
      'roll [dice…]',
      'units [list]',
      'cowsay [-W <N>] [text…]',
      'cowthink [-W <N>] [text…]',
      'figlet [text…]',
      'banner [text…]',
      'lolcat [-p <SPREAD>] [-S <PHASE>] [text…]',
      'wtf [-l] [terms…]',
      'qr [text…]',
      'fortune',
      'cal [month] [year]',
      'weather [--units <system>] [--days <N>] [place…]',
    ]);
    expect(calcCommand.help.usage).toBe('calc <expression>');
    expect(morseCommand.help.usage).toBe('morse [-d] [text]');
  });
});

describe('each parses its line as it did', () => {
  it('reads the text toys\' words', async () => {
    expect(await typed_get(revCommand, 'hello world')).toEqual({ subcommand: null, operands: { text: ['hello', 'world'] }, options: {} });
    expect(await typed_get(tacCommand, '')).toEqual({ subcommand: null, operands: { text: [] }, options: {} });
    expect(await typed_get(rot13Command, "'Hello, World'")).toEqual({ subcommand: null, operands: { text: ['Hello, World'] }, options: {} });
    expect(await typed_get(shufCommand, 'a b c')).toEqual({ subcommand: null, operands: { words: ['a', 'b', 'c'] }, options: {} });
    expect(await typed_get(yesCommand, 'no -n 3')).toEqual({ subcommand: null, operands: { words: ['no'] }, options: { count: 3 } });
  });

  it('reads seq as numbers, a negative one an operand', async () => {
    expect(await typed_get(seqCommand, '5')).toEqual({ subcommand: null, operands: { numbers: [5] }, options: {} });
    expect(await typed_get(seqCommand, '10 -2 0')).toEqual({ subcommand: null, operands: { numbers: [10, -2, 0] }, options: {} });
    expect(await typed_get(seqCommand, '0 0.5 1')).toEqual({ subcommand: null, operands: { numbers: [0, 0.5, 1] }, options: {} });
  });

  it('reads the number toys\' words', async () => {
    expect(await typed_get(factorCommand, '360 2026')).toEqual({ subcommand: null, operands: { numbers: [360, 2026] }, options: {} });
    expect(await typed_get(primesCommand, '1000 1100')).toEqual({ subcommand: null, operands: { numbers: [1000, 1100] }, options: {} });
    expect(await typed_get(rollCommand, 'd20 3d8+2')).toEqual({ subcommand: null, operands: { dice: ['d20', '3d8+2'] }, options: {} });
    expect(await typed_get(unitsCommand, '10 mm in')).toEqual({ subcommand: null, operands: { value: 10, from: 'mm', to: 'in', target: undefined }, options: {} });
    expect(await typed_get(unitsCommand, '72 F to C')).toEqual({ subcommand: null, operands: { value: 72, from: 'F', to: 'to', target: 'C' }, options: {} });
    expect(await typed_get(unitsCommand, '-40 C F')).toEqual({ subcommand: null, operands: { value: -40, from: 'C', to: 'F', target: undefined }, options: {} });
    expect(await typed_get(unitsCommand, 'list')).toEqual({ subcommand: 'list', operands: {}, options: {} });
  });

  it('reads the drawing toys\' words and options', async () => {
    expect(await typed_get(cowsayCommand, '-W 20 hello there')).toEqual({ subcommand: null, operands: { text: ['hello', 'there'] }, options: { width: 20 } });
    expect(await typed_get(cowthinkCommand, 'hmm')).toEqual({ subcommand: null, operands: { text: ['hmm'] }, options: { width: undefined } });
    expect(await typed_get(figletCommand, 'LCARS')).toEqual({ subcommand: null, operands: { text: ['LCARS'] }, options: {} });
    expect(await typed_get(bannerCommand, 'ChRIS 2')).toEqual({ subcommand: null, operands: { text: ['ChRIS', '2'] }, options: {} });
    expect(await typed_get(lolcatCommand, '-p 12 -S 0 rainbow')).toEqual({ subcommand: null, operands: { text: ['rainbow'] }, options: { spread: 12, phase: 0 } });
    expect(await typed_get(qrCommand, 'https://example.org')).toEqual({ subcommand: null, operands: { text: ['https://example.org'] }, options: {} });
  });

  it('reads wtf, fortune, cal and weather', async () => {
    expect(await typed_get(wtfCommand, 'is lonk')).toEqual({ subcommand: null, operands: { terms: ['is', 'lonk'] }, options: { list: false } });
    expect(await typed_get(wtfCommand, '--list')).toEqual({ subcommand: null, operands: { terms: [] }, options: { list: true } });
    expect(await typed_get(fortuneCommand, '')).toEqual({ subcommand: null, operands: {}, options: {} });
    expect(await typed_get(calCommand, '7 2026')).toEqual({ subcommand: null, operands: { month: 7, year: 2026 }, options: {} });
    expect(await typed_get(calCommand, '2026')).toEqual({ subcommand: null, operands: { month: 2026, year: undefined }, options: {} });
    expect(await typed_get(weatherCommand, 'Cape Town -u imperial -d 7')).toEqual({
      subcommand: null, operands: { place: ['Cape', 'Town'] }, options: { units: 'imperial', days: 7 },
    });
    expect(await typed_get(weatherCommand, '--units=metric')).toEqual({ subcommand: null, operands: { place: [] }, options: { units: 'metric', days: undefined } });
  });

  it('takes the words of rev as text after --, so a dash word is reversed rather than refused', async () => {
    expect(await typed_get(revCommand, '-- -x')).toEqual({ subcommand: null, operands: { text: ['-x'] }, options: {} });
  });
});

describe('each refuses a bad line before its handler runs', () => {
  it('refuses an option it does not declare', async () => {
    expect(await refusal_get(revCommand, '-x')).toMatch(/^rev: invalid option -- 'x'; usage: rev/);
    expect(await refusal_get(figletCommand, '--bold hi')).toMatch(/^figlet: unrecognized option '--bold'/);
    expect(await refusal_get(fortuneCommand, '-x')).toMatch(/^fortune: invalid option -- 'x'/);
    expect(await refusal_get(wtfCommand, '--all')).toMatch(/^wtf: unrecognized option '--all'/);
    expect(await refusal_get(weatherCommand, '--celsius')).toMatch(/^weather: unrecognized option '--celsius'/);
  });

  it('refuses a value that is not of its kind or out of its bounds', async () => {
    expect(await refusal_get(yesCommand, '-n x')).toMatch(/^yes: .*not a whole number/);
    expect(await refusal_get(yesCommand, '-n 0')).toMatch(/^yes: /);
    expect(await refusal_get(cowsayCommand, '-W 4 hi')).toMatch(/^cowsay: /);
    expect(await refusal_get(cowthinkCommand, '-W many')).toMatch(/^cowthink: .*not a whole number/);
    expect(await refusal_get(lolcatCommand, '-p 0 hi')).toMatch(/^lolcat: /);
    expect(await refusal_get(lolcatCommand, '-S far hi')).toMatch(/^lolcat: .*not a number/);
    expect(await refusal_get(seqCommand, 'a')).toMatch(/^seq: .*not a number/);
    expect(await refusal_get(factorCommand, 'abc')).toMatch(/^factor: .*not a whole number/);
    expect(await refusal_get(factorCommand, '0')).toMatch(/^factor: /);
    expect(await refusal_get(primesCommand, '1.5')).toMatch(/^primes: .*not a whole number/);
    expect(await refusal_get(unitsCommand, 'many mm in')).toMatch(/^units: .*not a number/);
    expect(await refusal_get(calCommand, 'july')).toMatch(/^cal: .*not a whole number/);
    expect(await refusal_get(weatherCommand, '--units kelvin')).toMatch(/^weather: .*kelvin/);
    expect(await refusal_get(weatherCommand, '-d 40')).toMatch(/^weather: .*40/);
    expect(await refusal_get(weatherCommand, '-d lots')).toMatch(/^weather: .*not a whole number/);
  });

  it('refuses a missing operand, a stray operand, and a missing option value', async () => {
    expect(await refusal_get(seqCommand, '')).toMatch(/^seq: missing operand <numbers>/);
    expect(await refusal_get(primesCommand, '')).toMatch(/^primes: missing operand <numbers>/);
    expect(await refusal_get(unitsCommand, '10 mm')).toMatch(/^units: missing operand <to>/);
    expect(await refusal_get(unitsCommand, '')).toMatch(/^units: missing operand <value>/);
    expect(await refusal_get(unitsCommand, '1 2 3 4 5')).toMatch(/^units: unexpected operand '5'/);
    expect(await refusal_get(fortuneCommand, 'tell me')).toMatch(/^fortune: unexpected operand 'tell'/);
    expect(await refusal_get(calCommand, '1 2 3')).toMatch(/^cal: unexpected operand '3'/);
    expect(await refusal_get(yesCommand, '-n')).toMatch(/^yes: option '-n' wants a value/);
    expect(await refusal_get(weatherCommand, '--days')).toMatch(/^weather: option '--days' wants a value/);
  });
});

describe('calc and morse take their words as they come', () => {
  it('calc reads a leading dash as arithmetic', async () => {
    expect(calcCommand.grammar).toBe('expression');
    expect((await builtin_calc(['-3+4'])).rendered).toBe('1\n');
    expect((await builtin_calc(['2', '+', '3'])).rendered).toBe('5\n');
    expect((await builtin_calc(['2', '+'])).status).toBe('error');
  });

  it('morse reads a line of dashes as code, and -d at the front as the switch', async () => {
    expect(morseCommand.grammar).toBe('expression');
    expect((await builtin_morse(['sos'])).rendered).toBe('... --- ...\n');
    expect((await builtin_morse(['-d', '...', '---', '...'])).rendered).toBe('SOS\n');
    expect((await builtin_morse(['--decode', '.-'])).rendered).toBe('A\n');
    expect((await builtin_morse([])).status).toBe('error');
  });
});

describe('units keeps its joining word and its list', () => {
  it('converts with or without the joining word, and refuses a fourth word that is not one', async () => {
    expect((await builtin_units(['72', 'F', 'to', 'C'])).rendered).toMatch(/^72 F = 22\.2+ C\n$/);
    expect((await builtin_units(['10', 'mm', 'in'])).rendered).toMatch(/^10 mm = 0\.39\d+ in\n$/);
    expect((await builtin_units(['10', 'mm', 'by', 'in'])).status).toBe('error');
    expect((await builtin_units(['list'])).rendered).toContain('GiB');
  });
});
