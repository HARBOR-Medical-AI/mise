/**
 * @file The text toys on the games shelf: each answers in kind, bounded
 * where the original ran forever, and reads what was piped in.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
}));
const { text_rev, text_tac, text_rot13, seq_numbers, lines_shuffle, builtin_yes, builtin_seq, builtin_rev, builtin_tac, builtin_shuf, builtin_rot13, YES_DEFAULT } = await import('../src/builtins/games/text.js');
const { factors_compute, primes_between, dice_roll, calc_evaluate, units_convert, builtin_units, builtin_roll, builtin_factor, builtin_primes, builtin_calc } = await import('../src/builtins/games/numbers.js');
const { cowsay_render, text_wrap, bubble_draw, BRAIN, builtin_cowsay } = await import('../src/builtins/games/cowsay.js');
const { figlet_render, FACE_ROWS, builtin_figlet, builtin_banner } = await import('../src/builtins/games/figlet.js');
const { lolcat_paint, rainbow_rgb, builtin_lolcat } = await import('../src/builtins/games/lolcat.js');
const { morse_encode, morse_decode, builtin_morse } = await import('../src/builtins/games/morse.js');
const { stdin_set, stdin_take, text_input } = await import('../src/builtins/games/stdin.js');

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('piped input', () => {
  it('is taken once, and the arguments stand in for it', () => {
    stdin_set('from the pipe\n');
    expect(text_input(['ignored'])).toBe('from the pipe\n');
    expect(stdin_take()).toBeNull();
    expect(text_input(['a', 'b'])).toBe('a b');
    expect(text_input([])).toBeNull();
  });
});

describe('rev, tac, rot13, seq, shuf, yes', () => {
  it('reverse characters, lines, and letters', () => {
    expect(text_rev('abc\nde')).toBe('cba\ned');
    expect(text_tac('1\n2\n3\n')).toBe('3\n2\n1\n');
    expect(text_rot13('Hello, World!')).toBe('Uryyb, Jbeyq!');
    expect(text_rot13(text_rot13('round trip'))).toBe('round trip');
  });

  it('counts as seq does, and refuses nonsense', () => {
    expect(seq_numbers([3])).toEqual({ numbers: [1, 2, 3] });
    expect(seq_numbers([2, 5])).toEqual({ numbers: [2, 3, 4, 5] });
    expect(seq_numbers([10, -5, 0])).toEqual({ numbers: [10, 5, 0] });
    expect(seq_numbers([0, 0.5, 1])).toEqual({ numbers: [0, 0.5, 1] });
    expect('refusal' in seq_numbers([])).toBe(true);
    expect('refusal' in seq_numbers([1, 0, 5])).toBe(true);
  });

  it('shuffles with a given chance, keeping every line', () => {
    const out: string[] = lines_shuffle(['a', 'b', 'c', 'd'], (): number => 0);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('yes is bounded and says so', async () => {
    const out: string = plain((await builtin_yes([])).rendered);
    expect(out.split('\n').filter((l: string): boolean => l === 'y').length).toBe(YES_DEFAULT);
    expect(out).toContain('of forever');
    const three: string = plain((await builtin_yes(['no', '-n', '3'])).rendered);
    expect(three.startsWith('no\nno\nno\n')).toBe(true);
    expect((await builtin_yes(['-n', 'x'])).status).toBe('error');
  });

  it('reads the pipe before its arguments', async () => {
    stdin_set('piped\n');
    expect((await builtin_rev(['typed'])).rendered).toBe('depip\n');
    expect((await builtin_seq(['bogus'])).status).toBe('error');
  });
});

describe('factor, primes, roll, calc, units', () => {
  it('factors and lists primes', () => {
    expect(factors_compute(360)).toEqual([2, 2, 2, 3, 3, 5]);
    expect(factors_compute(97)).toEqual([97]);
    expect(primes_between(2, 20)).toEqual([2, 3, 5, 7, 11, 13, 17, 19]);
    expect(primes_between(90, 100)).toEqual([97]);
  });

  it('rolls dice the tabletop way', () => {
    const r = dice_roll('2d6+1', (): number => 0.99);
    expect(r).toEqual({ rolls: [6, 6], modifier: 1, total: 13 });
    expect(dice_roll('d20', (): number => 0)).toEqual({ rolls: [1], modifier: 0, total: 1 });
    expect('refusal' in dice_roll('two dice')).toBe(true);
    expect('refusal' in dice_roll('1000d2')).toBe(true);
  });

  it('roll bare is one d6', async () => {
    const out: string = plain((await builtin_roll([])).rendered);
    expect(out).toMatch(/^1d6: [1-6]\n$/);
  });

  it('calc reads arithmetic without a shell', () => {
    expect(calc_evaluate('2^10')).toBe(1024);
    expect(calc_evaluate('(3+4)*5')).toBe(35);
    expect(calc_evaluate('-2^2')).toBe(4);
    expect(calc_evaluate('10 % 4 + 2 * 3')).toBe(8);
    expect(calc_evaluate('sqrt(2)*pi')).toBeCloseTo(4.44288, 4);
    expect(calc_evaluate('2 ^ 3 ^ 2')).toBe(512);
    expect(() => calc_evaluate('2 +')).toThrow(/expected a number/);
    expect(() => calc_evaluate('foo(2)')).toThrow(/unknown name/);
    expect(() => calc_evaluate('(2')).toThrow(/expected '\)'/);
    expect(() => calc_evaluate('2)')).toThrow(/unexpected/);
  });

  it('units converts within a kind and refuses across kinds', () => {
    const inches = units_convert(254, 'mm', 'in');
    expect('value' in inches && inches.value).toBeCloseTo(10, 9);
    const f = units_convert(100, 'C', 'F');
    expect('value' in f && f.value).toBeCloseTo(212, 9);
    const gib = units_convert(1, 'GiB', 'MB');
    expect('value' in gib && gib.value).toBeCloseTo(1073.741824, 6);
    expect(units_convert(1, 'kg', 'm')).toEqual({ refusal: 'units: cannot convert mass to length' });
    expect('refusal' in units_convert(1, 'furlong', 'm')).toBe(true);
  });

  it('units takes the joining word, and lists what it knows', async () => {
    expect(plain((await builtin_units(['72', 'F', 'to', 'C'])).rendered)).toMatch(/^72 F = 22\.2+ C\n$/);
    expect(plain((await builtin_units(['list'])).rendered)).toContain('GiB');
    expect((await builtin_units(['many'])).status).toBe('error');
  });
});

describe('cowsay, figlet, lolcat, morse', () => {
  it('wraps and draws a bubble, speech and thought', () => {
    expect(text_wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(bubble_draw(['hi'], false)).toEqual([' ____', '< hi >', ' ----']);
    const thought: string[] = bubble_draw(['a', 'bb'], true);
    expect(thought[1]).toBe('( a  )');
    expect(bubble_draw(['a', 'b', 'c'], false)[1]).toBe('/ a \\');
  });

  it('puts the brain under the bubble', async () => {
    const picture: string = cowsay_render('moo');
    expect(picture.split('\n')).toEqual(expect.arrayContaining([...BRAIN]));
    expect(picture).toContain('< moo >');
    stdin_set('from fortune\n');
    const said: string = (await builtin_cowsay([])).rendered;
    expect(said).toContain('< from fortune >');
    expect((await builtin_cowsay(['-W', '3', 'x'])).status).toBe('error');
    expect((await builtin_cowsay([])).status).toBe('error');
  });

  it('sets big letters five rows tall, unknown glyphs as ?', () => {
    const rows: string[] = figlet_render('Hi');
    expect(rows.length).toBe(FACE_ROWS);
    expect(rows[0]).toBe('#   # #####');
    expect(figlet_render('~')[0]).toBe(figlet_render('?')[0]);
    expect(figlet_render('a', '█')[0]).toBe(' ███');
    expect(figlet_render('a\nb').length).toBe(FACE_ROWS * 2 + 1);
  });

  it('paints a rainbow, leaving spaces plain and the text intact', () => {
    const painted: string = lolcat_paint('ab c', 24, 0);
    expect(plain(painted)).toBe('ab c');
    expect(painted).toMatch(/\x1b\[38;2;\d+;\d+;\d+ma/);
    expect(painted.includes(' ')).toBe(true);
    const [r, g, b] = rainbow_rgb(0, 24);
    for (const c of [r, g, b]) { expect(c).toBeGreaterThanOrEqual(55); expect(c).toBeLessThanOrEqual(255); }
  });

  it('taps text out and reads it back', async () => {
    expect(morse_encode('SOS')).toBe('... --- ...');
    expect(morse_encode('hi there')).toBe('.... .. / - .... . .-. .');
    expect(morse_decode('.... .. / - .... . .-. .')).toBe('HI THERE');
    expect(morse_decode('.... ........')).toBe('H?');
    expect(plain((await builtin_morse(['-d', '...', '---', '...'])).rendered)).toBe('SOS\n');
    expect((await builtin_morse(['~'])).status).toBe('error');
  });
});

describe('the toys as commands', () => {
  it('tac, shuf and rot13 read the pipe or the words, and refuse nothing to work on', async () => {
    stdin_set('1\n2\n');
    expect((await builtin_tac([])).rendered).toBe('2\n1\n');
    expect((await builtin_tac([])).status).toBe('error');
    stdin_set('a\nb\nc\n');
    const shuffled = await builtin_shuf([]);
    expect(((shuffled.model as { data: { lines: string[] } }).data.lines).sort()).toEqual(['a', 'b', 'c']);
    expect((await builtin_shuf(['x'])).rendered).toBe('x\n');
    expect((await builtin_shuf([])).status).toBe('error');
    expect((await builtin_rot13(['Hello'])).rendered).toBe('Uryyb\n');
    expect((await builtin_rot13([])).status).toBe('error');
    expect((await builtin_seq(['x'])).status).toBe('error');
  });

  it('factor, primes and calc answer and refuse by name', async () => {
    expect((await builtin_factor(['12', '7'])).rendered).toBe('12: 2 2 3\n7: 7\n');
    expect((await builtin_factor(['1'])).rendered).toBe('1:\n');
    expect((await builtin_factor([])).status).toBe('error');
    expect((await builtin_factor(['-3'])).status).toBe('error');
    expect((await builtin_primes(['10'])).rendered).toBe('2 3 5 7\n');
    expect((await builtin_primes(['10', '20'])).rendered).toBe('11 13 17 19\n');
    expect((await builtin_primes([])).status).toBe('error');
    expect((await builtin_primes(['a'])).status).toBe('error');
    expect((await builtin_calc(['2^10'])).rendered).toBe('1024\n');
    expect((await builtin_calc(['1/3'])).rendered).toBe('0.333333333333\n');
    expect((await builtin_calc([])).status).toBe('error');
    expect((await builtin_calc(['2 +'])).status).toBe('error');
  });

  it('figlet and banner set the words; lolcat paints them, with its two flags', async () => {
    const big = await builtin_figlet(['HI']);
    expect(big.rendered.split('\n').length - 1).toBe(FACE_ROWS);
    expect(big.rendered).toContain('█');
    expect((await builtin_banner(['HI'])).rendered).toContain('#');
    expect((await builtin_figlet([])).status).toBe('error');
    const painted = await builtin_lolcat(['-p', '10', '-S', '3', 'rainbow']);
    expect(plain(painted.rendered)).toBe('rainbow\n');
    expect(painted.model).toEqual({ kind: 'games.lolcat', data: { text: 'rainbow', spread: 10, phase: 3 } });
    stdin_set('piped\n');
    expect(plain((await builtin_lolcat([])).rendered)).toBe('piped\n');
    expect((await builtin_lolcat([])).status).toBe('error');
    expect((await builtin_lolcat(['-p', 'x'])).status).toBe('error');
    expect((await builtin_lolcat(['-p', '0'])).status).toBe('error');
    expect((await builtin_lolcat(['-z'])).status).toBe('error');
  });
});
