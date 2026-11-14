/**
 * @file Number toys from the shelf: `factor`, `primes`, `roll`, `calc`, `units`.
 *
 * `calc` is a small arithmetic reader of its own — no `eval` — with the
 * usual operators, parentheses, a few functions and `pi` and `e`. `units`
 * converts within a modest table: length, mass, time, data and temperature.
 *
 * @module
 */
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar, type ExpressionDeclaration } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** The most primes `primes` lists in one call. */
export const PRIMES_MAX: number = 10_000;

/** The prime factors of n, smallest first, with repeats. */
export function factors_compute(n: number): number[] {
  const out: number[] = [];
  let rest: number = n;
  for (let p: number = 2; p * p <= rest; p++) {
    while (rest % p === 0) { out.push(p); rest /= p; }
  }
  if (rest > 1) out.push(rest);
  return out;
}

/** The primes in [from, to], at most PRIMES_MAX of them. */
export function primes_between(from: number, to: number): number[] {
  const out: number[] = [];
  const isPrime = (n: number): boolean => {
    if (n < 2) return false;
    for (let p: number = 2; p * p <= n; p++) if (n % p === 0) return false;
    return true;
  };
  for (let n: number = Math.max(2, from); n <= to && out.length < PRIMES_MAX; n++) if (isPrime(n)) out.push(n);
  return out;
}

/**
 * Rolls dice written as `NdS[+M]`, e.g. `2d6+1`, `d20`.
 *
 * @returns Each die's face and the total, or a refusal.
 */
export function dice_roll(spec: string, random: () => number = Math.random): { rolls: number[]; modifier: number; total: number } | { refusal: string } {
  const m: RegExpMatchArray | null = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(spec.trim());
  if (m === null) return { refusal: `roll: '${spec}' is not dice (try 2d6, d20, 3d8+2)` };
  const count: number = m[1] === '' || m[1] === undefined ? 1 : Number(m[1]);
  const sides: number = Number(m[2]);
  const modifier: number = m[3] === undefined ? 0 : Number(m[3]);
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return { refusal: 'roll: 1 to 100 dice of 2 to 1000 sides' };
  const rolls: number[] = Array.from({ length: count }, (): number => 1 + Math.floor(random() * sides));
  return { rolls, modifier, total: rolls.reduce((a: number, b: number): number => a + b, 0) + modifier };
}

/* ------------------------------------------------------------- calc */

const CALC_FUNCTIONS: Readonly<Record<string, (x: number) => number>> = {
  sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
};
const CALC_CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

/**
 * Evaluates an arithmetic expression: + - * / % ^, parentheses, unary minus,
 * the functions above, pi and e. Throws with a reason on a malformed one.
 */
export function calc_evaluate(expression: string): number {
  const src: string = expression.replace(/\s+/g, '');
  let at: number = 0;
  const peek = (): string => src[at] ?? '';
  const fail = (why: string): never => { throw new Error(`calc: ${why} at position ${at + 1}`); };
  const number = (): number => {
    const m: RegExpMatchArray | null = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(at));
    if (m === null) return fail('expected a number');
    at += m[0].length;
    return Number(m[0]);
  };
  const atom = (): number => {
    if (peek() === '(') {
      at++;
      const v: number = expr();
      if (peek() !== ')') return fail("expected ')'");
      at++;
      return v;
    }
    if (peek() === '-') { at++; return -atom(); }
    if (peek() === '+') { at++; return atom(); }
    const word: RegExpMatchArray | null = /^[a-z][a-z0-9]*/i.exec(src.slice(at));
    if (word !== null) {
      const name: string = word[0].toLowerCase();
      at += name.length;
      if (name in CALC_CONSTANTS) return CALC_CONSTANTS[name] as number;
      const fn: ((x: number) => number) | undefined = CALC_FUNCTIONS[name];
      if (fn === undefined) return fail(`unknown name '${name}'`);
      if (peek() !== '(') return fail(`'${name}' wants parentheses`);
      at++;
      const v: number = expr();
      if (peek() !== ')') return fail("expected ')'");
      at++;
      return fn(v);
    }
    return number();
  };
  const power = (): number => {
    const base: number = atom();
    if (peek() === '^') { at++; return Math.pow(base, power()); }
    return base;
  };
  const term = (): number => {
    let v: number = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op: string = peek(); at++;
      const r: number = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const expr = (): number => {
    let v: number = term();
    while (peek() === '+' || peek() === '-') {
      const op: string = peek(); at++;
      const r: number = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  if (src === '') fail('nothing to compute');
  const value: number = expr();
  if (at < src.length) fail(`unexpected '${peek()}'`);
  return value;
}

/* ------------------------------------------------------------ units */

/** A unit: its kind and its size in the kind's base unit. */
interface Unit { kind: string; factor: number }

const UNITS: Readonly<Record<string, Unit>> = {
  m: { kind: 'length', factor: 1 }, meter: { kind: 'length', factor: 1 }, metre: { kind: 'length', factor: 1 },
  km: { kind: 'length', factor: 1000 }, cm: { kind: 'length', factor: 0.01 }, mm: { kind: 'length', factor: 0.001 }, um: { kind: 'length', factor: 1e-6 },
  in: { kind: 'length', factor: 0.0254 }, inch: { kind: 'length', factor: 0.0254 }, ft: { kind: 'length', factor: 0.3048 }, foot: { kind: 'length', factor: 0.3048 }, feet: { kind: 'length', factor: 0.3048 },
  yd: { kind: 'length', factor: 0.9144 }, mi: { kind: 'length', factor: 1609.344 }, mile: { kind: 'length', factor: 1609.344 }, nmi: { kind: 'length', factor: 1852 },
  kg: { kind: 'mass', factor: 1 }, g: { kind: 'mass', factor: 0.001 }, mg: { kind: 'mass', factor: 1e-6 }, lb: { kind: 'mass', factor: 0.45359237 }, oz: { kind: 'mass', factor: 0.028349523125 }, st: { kind: 'mass', factor: 6.35029318 },
  s: { kind: 'time', factor: 1 }, sec: { kind: 'time', factor: 1 }, ms: { kind: 'time', factor: 0.001 }, us: { kind: 'time', factor: 1e-6 }, min: { kind: 'time', factor: 60 }, h: { kind: 'time', factor: 3600 }, hr: { kind: 'time', factor: 3600 },
  d: { kind: 'time', factor: 86400 }, day: { kind: 'time', factor: 86400 }, wk: { kind: 'time', factor: 604800 }, week: { kind: 'time', factor: 604800 }, yr: { kind: 'time', factor: 31557600 }, year: { kind: 'time', factor: 31557600 },
  B: { kind: 'data', factor: 1 }, byte: { kind: 'data', factor: 1 }, kB: { kind: 'data', factor: 1e3 }, MB: { kind: 'data', factor: 1e6 }, GB: { kind: 'data', factor: 1e9 }, TB: { kind: 'data', factor: 1e12 },
  KiB: { kind: 'data', factor: 1024 }, MiB: { kind: 'data', factor: 1024 ** 2 }, GiB: { kind: 'data', factor: 1024 ** 3 }, TiB: { kind: 'data', factor: 1024 ** 4 }, bit: { kind: 'data', factor: 0.125 },
  C: { kind: 'temperature', factor: 1 }, F: { kind: 'temperature', factor: 1 }, K: { kind: 'temperature', factor: 1 },
};

/** Temperature is affine, not a factor: converted by hand. */
function temperature_convert(value: number, from: string, to: string): number {
  const celsius: number = from === 'C' ? value : from === 'F' ? (value - 32) * 5 / 9 : value - 273.15;
  return to === 'C' ? celsius : to === 'F' ? celsius * 9 / 5 + 32 : celsius + 273.15;
}

/**
 * Converts a quantity between two units of one kind.
 *
 * @returns The converted value, or a refusal naming what went wrong.
 */
export function units_convert(value: number, from: string, to: string): { value: number } | { refusal: string } {
  const a: Unit | undefined = UNITS[from] ?? UNITS[from.toLowerCase()];
  const b: Unit | undefined = UNITS[to] ?? UNITS[to.toLowerCase()];
  if (a === undefined) return { refusal: `units: unknown unit '${from}'` };
  if (b === undefined) return { refusal: `units: unknown unit '${to}'` };
  if (a.kind !== b.kind) return { refusal: `units: cannot convert ${a.kind} to ${b.kind}` };
  if (a.kind === 'temperature') return { value: temperature_convert(value, from.toUpperCase(), to.toUpperCase()) };
  return { value: value * a.factor / b.factor };
}

/** The unit names `units` knows, for its help and its refusals. */
export function units_known(): string[] {
  return Object.keys(UNITS);
}

/* ----------------------------------------------------- declarations */

/** What a `factor` line may hold. */
const FACTOR_GRAMMAR = {
  operands: [{ name: 'numbers', kind: 'int', min: 1, max: Number.MAX_SAFE_INTEGER, optional: true, repeat: true, summary: 'Whole numbers to factor (default: the numbers piped in)' }],
} as const satisfies CommandGrammar;

/**
 * `factor N [N...]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [factorCommand] });
 * ```
 */
export const factorCommand = command_declare({
  name: 'factor',
  grammar: FACTOR_GRAMMAR,
  help: {
    summary: 'Prime factors of a number',
    description: 'Prints each number with its prime factors, smallest first, repeats included, as factor does.',
    examples: ['factor 360', 'factor 2026 1729'],
    posix: { group: 'System', differs: 'as factor' },
  },
  holds: [],
  handler: async (args: CommandArguments<typeof FACTOR_GRAMMAR>): Promise<CommandEnvelope> => factor_run(args.operands.numbers.map(String)),
});

/**
 * `factor` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `factor`.
 * @returns The factorisations, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_factor(['360']);
 * ```
 */
export async function builtin_factor(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(factorCommand, args);
}

/**
 * Factors the numbers piped in, else the numbers given.
 *
 * @param numbers - The numbers given, as words.
 * @returns Each number with its prime factors, or a refusal for a word that is not a positive whole number.
 *
 * @example
 * ```ts
 * await factor_run(['360']); // 360: 2 2 2 3 3 5
 * ```
 */
export async function factor_run(numbers: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const words: string[] = text_input(numbers)?.trim().split(/\s+/) ?? [];
  if (words.length === 0) return envelope_error('', undefined, 'factor: usage: factor N [N...]\n');
  const lines: string[] = [];
  const data: Array<{ n: number; factors: number[] }> = [];
  for (const word of words) {
    const n: number = Number(word);
    if (!Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) return envelope_error('', undefined, `factor: '${word}' is not a positive whole number\n`);
    const factors: number[] = n === 1 ? [] : factors_compute(n);
    data.push({ n, factors });
    lines.push(`${n}: ${factors.join(' ')}`.trimEnd());
  }
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.factor', data: { numbers: data } });
}

/** What a `primes` line may hold. */
const PRIMES_GRAMMAR = {
  operands: [{ name: 'numbers', kind: 'int', repeat: true, summary: '[FROM] TO' }],
} as const satisfies CommandGrammar;

/**
 * `primes [FROM] TO`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [primesCommand] });
 * ```
 */
export const primesCommand = command_declare({
  name: 'primes',
  grammar: PRIMES_GRAMMAR,
  help: {
    summary: 'The primes up to a number',
    description: 'Lists the primes from FROM (2 when omitted) to TO, at most 10000 of them.',
    examples: ['primes 100', 'primes 1000 1100'],
    posix: { group: 'System', differs: 'as primes' },
  },
  holds: [],
  handler: async (args: CommandArguments<typeof PRIMES_GRAMMAR>): Promise<CommandEnvelope> => primes_run(args.operands.numbers),
});

/**
 * `primes` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `primes`.
 * @returns The primes, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_primes(['20']);
 * ```
 */
export async function builtin_primes(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(primesCommand, args);
}

/**
 * Lists the primes in a range.
 *
 * @param nums - `TO`, or `FROM` and `TO`.
 * @returns The primes on one line, or a refusal for a wrong count of numbers.
 *
 * @example
 * ```ts
 * await primes_run([1000, 1100]);
 * ```
 */
export async function primes_run(nums: ReadonlyArray<number>): Promise<CommandEnvelope> {
  if (nums.length === 0 || nums.length > 2) return envelope_error('', undefined, 'primes: usage: primes [FROM] TO\n');
  const [from, to]: [number, number] = nums.length === 1 ? [2, nums[0] as number] : [nums[0] as number, nums[1] as number];
  const primes: number[] = primes_between(from, to);
  const note: string = primes.length >= PRIMES_MAX ? `primes: stopped at ${PRIMES_MAX}\n` : '';
  return envelope_ok(`${primes.join(' ')}\n${note}`, { kind: 'games.primes', data: { from, to, primes } });
}

/** What a `roll` line may hold. */
const ROLL_GRAMMAR = {
  operands: [{ name: 'dice', kind: 'word', optional: true, repeat: true, summary: 'Dice as NdS[+M] (default 1d6)' }],
} as const satisfies CommandGrammar;

/**
 * `roll [NdS[+M]...]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [rollCommand] });
 * ```
 */
export const rollCommand = command_declare({
  name: 'roll',
  grammar: ROLL_GRAMMAR,
  help: {
    summary: 'Roll dice: roll 2d6+1, roll d20',
    description: 'Rolls dice written the tabletop way: N dice of S sides, plus or minus a modifier. Bare roll is one six-sided die. Shows each face and the total.',
    examples: ['roll', 'roll 2d6', 'roll d20 3d8+2'],
  },
  handler: async (args: CommandArguments<typeof ROLL_GRAMMAR>): Promise<CommandEnvelope> => roll_run(args.operands.dice),
});

/**
 * `roll` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `roll`.
 * @returns The rolls, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_roll(['2d6']);
 * ```
 */
export async function builtin_roll(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(rollCommand, args);
}

/**
 * Rolls each die spec, one six-sided die when there are none.
 *
 * @param dice - The specs, as `NdS[+M]`.
 * @returns Each spec's faces and total, or a refusal for a spec that is not dice.
 *
 * @example
 * ```ts
 * await roll_run(['2d6+1']);
 * ```
 */
export async function roll_run(dice: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const specs: ReadonlyArray<string> = dice.length === 0 ? ['1d6'] : dice;
  const lines: string[] = [];
  const data: Array<{ dice: string; rolls: number[]; total: number }> = [];
  for (const spec of specs) {
    const r = dice_roll(spec);
    if ('refusal' in r) return envelope_error('', undefined, `${r.refusal}\n`);
    const mod: string = r.modifier === 0 ? '' : ` ${r.modifier > 0 ? '+' : '-'} ${Math.abs(r.modifier)}`;
    lines.push(r.rolls.length === 1 && r.modifier === 0 ? `${spec}: ${r.total}` : `${spec}: ${r.rolls.join(' + ')}${mod} = ${r.total}`);
    data.push({ dice: spec, rolls: r.rolls, total: r.total });
  }
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.roll', data: { rolls: data } });
}

/**
 * `calc EXPRESSION`: the declaration. Its words are an arithmetic
 * expression, so one may begin with a dash (`calc -3+4`): it takes them
 * as they come, parsing none as an option.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [calcCommand] });
 * ```
 */
export const calcCommand: ExpressionDeclaration = {
  name: 'calc',
  grammar: 'expression',
  help: {
    usage: 'calc <expression>',
    summary: 'Arithmetic: calc 2^10, calc sqrt(2)*pi',
    description: 'Evaluates an arithmetic expression: + - * / % ^, parentheses, sqrt, abs, ln, log, log2, exp, sin, cos, tan, asin, acos, atan, floor, ceil, round, and the constants pi, e and tau. No shell is involved. Its words are the expression, so one may begin with a dash: calc -3+4.',
    examples: ['calc 2^10', 'calc (3+4)*5', 'calc sqrt(2)*pi', 'calc 1024*1024'],
  },
  holds: [],
  handler: (args: string[]): Promise<CommandEnvelope> => calc_run(args),
};

/**
 * `calc` over words already split.
 *
 * @param args - The words after `calc`.
 * @returns The value, or the refusal of a malformed expression.
 *
 * @example
 * ```ts
 * await builtin_calc(['2^10']);
 * ```
 */
export async function builtin_calc(args: string[]): Promise<CommandEnvelope> {
  return calc_run(args);
}

/**
 * Evaluates the piped expression, else the words joined.
 *
 * @param words - The words of the expression.
 * @returns The value, or a refusal naming what is wrong with the expression.
 *
 * @example
 * ```ts
 * await calc_run(['-3+4']); // 1
 * ```
 */
export async function calc_run(words: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const expression: string | null = text_input(words);
  if (expression === null) return envelope_error('', undefined, 'calc: usage: calc <expression>   (e.g. calc 2^10, calc sqrt(2)*pi)\n');
  try {
    const value: number = calc_evaluate(expression.trim());
    const shown: string = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
    return envelope_ok(`${shown}\n`, { kind: 'games.calc', data: { expression: expression.trim(), value } });
  } catch (error: unknown) {
    return envelope_error('', undefined, `${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** What a `units` line may hold: a conversion, or `list`. */
const UNITS_GRAMMAR = {
  operands: [
    { name: 'value', kind: 'number', summary: 'The quantity' },
    { name: 'from', kind: 'word', summary: 'The unit it is in' },
    { name: 'to', kind: 'word', summary: 'The unit to give it in (or the joining word to, in or as, then the unit)' },
    { name: 'target', kind: 'word', optional: true, summary: 'The unit to give it in, after the joining word' },
  ],
  subcommands: {
    list: { summary: 'Name the units known' },
  },
  bare: { summary: 'Convert a quantity' },
} as const satisfies CommandGrammar;

/**
 * `units VALUE FROM [to] TO | units list`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [unitsCommand] });
 * ```
 */
export const unitsCommand = command_declare({
  name: 'units',
  grammar: UNITS_GRAMMAR,
  help: {
    summary: 'Convert between units: units 10 mm in',
    description: 'Converts a quantity between two units of one kind: length (mm cm m km in ft yd mi), mass (g kg mg lb oz), time (ms s min h d wk yr), data (B kB MB GB TB KiB MiB GiB TiB bit) and temperature (C F K). units list names them all. The line is units VALUE FROM [to] TO, or units list.',
    examples: ['units 10 mm in', 'units 72 F to C', 'units 1 GiB MB', 'units list'],
    posix: { group: 'System', differs: 'a small set of conversions' },
  },
  holds: [],
  handler: async (args: CommandArguments<typeof UNITS_GRAMMAR>): Promise<CommandEnvelope> => {
    if (args.subcommand === 'list') return unitsList_run();
    const destination: string | null = units_destination(args.operands.to, args.operands.target);
    if (destination === null) return envelope_error('', undefined, 'units: usage: units VALUE FROM [to] TO   (units list names the units)\n');
    return units_run(args.operands.value, args.operands.from, destination);
  },
});

/**
 * `units` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `units`.
 * @returns The conversion, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_units(['10', 'mm', 'in']);
 * ```
 */
export async function builtin_units(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(unitsCommand, args);
}

/**
 * The unit a conversion is to: the third word, or the fourth after a joining word.
 *
 * @param to - The third word.
 * @param target - The fourth word, when there is one.
 * @returns The destination unit, or null when a fourth word follows a third that is not `to`, `in` or `as`.
 *
 * @example
 * ```ts
 * units_destination('to', 'in'); // 'in'
 * ```
 */
export function units_destination(to: string, target: string | undefined): string | null {
  if (target === undefined) return to;
  return /^(to|in|as)$/i.test(to) ? target : null;
}

/**
 * Names every unit `units` knows.
 *
 * @returns The names on one line.
 *
 * @example
 * ```ts
 * await unitsList_run();
 * ```
 */
export async function unitsList_run(): Promise<CommandEnvelope> {
  return envelope_ok(`${units_known().join(' ')}\n`, { kind: 'games.units', data: { known: units_known() } });
}

/**
 * Converts a quantity and says so.
 *
 * @param value - The quantity.
 * @param from - The unit it is in.
 * @param to - The unit to give it in.
 * @returns The conversion, or a refusal naming the unit or kind that does not fit.
 *
 * @example
 * ```ts
 * await units_run(10, 'mm', 'in'); // 10 mm = 0.3937007874 in
 * ```
 */
export async function units_run(value: number, from: string, to: string): Promise<CommandEnvelope> {
  const r = units_convert(value, from, to);
  if ('refusal' in r) return envelope_error('', undefined, `${r.refusal}\n`);
  const shown: string = String(Number(r.value.toPrecision(10)));
  return envelope_ok(`${value} ${from} = ${shown} ${to}\n`, { kind: 'games.units', data: { value, from, to, result: r.value } });
}
