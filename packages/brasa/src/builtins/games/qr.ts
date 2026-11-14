/**
 * @file `qr`: a QR code in the console, for a phone to read off the screen.
 *
 * A small encoder of its own — byte mode, error correction level L,
 * versions 1 to 10 (up to 271 bytes) — drawn in half-block characters so a
 * code is half as tall as it is wide, with the light modules bright: on a
 * dark console that is what a camera reads. No library: the whole of it
 * is below, and a surface may draw the matrix in the model its own way.
 *
 * @module
 */
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** Data codewords per version at level L (1..10). */
const DATA_CODEWORDS: ReadonlyArray<number> = [0, 19, 34, 55, 80, 108, 136, 156, 194, 232, 274];
/** Error-correction codewords per block, and the block counts, per version at level L. */
const EC_PER_BLOCK: ReadonlyArray<number> = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS: ReadonlyArray<number> = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
/** Alignment pattern centres per version. */
const ALIGNMENT: ReadonlyArray<ReadonlyArray<number>> = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
/** Version information bits for versions 7..10. */
const VERSION_BITS: Readonly<Record<number, number>> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
/** Format information bits for level L, by mask. */
const FORMAT_BITS: ReadonlyArray<number> = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
/** The most bytes the biggest version here carries. */
export const QR_MAX_BYTES: number = 271;

/* -------------------------------------------------- Galois field */
const EXP: number[] = new Array<number>(512).fill(0);
const LOG: number[] = new Array<number>(256).fill(0);
(() => {
  let x: number = 1;
  for (let i: number = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i: number = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();
const gf_mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[((LOG[a] as number) + (LOG[b] as number)) % 255] as number);

/** The Reed–Solomon remainder of `data` for `ec` check codewords. */
export function rs_remainder(data: number[], ec: number): number[] {
  let gen: number[] = [1];
  for (let i: number = 0; i < ec; i++) {
    const next: number[] = new Array<number>(gen.length + 1).fill(0);
    for (let j: number = 0; j < gen.length; j++) {
      next[j] ^= gen[j] as number;
      next[j + 1] ^= gf_mul(gen[j] as number, EXP[i] as number);
    }
    gen = next;
  }
  const rem: number[] = new Array<number>(ec).fill(0);
  for (const byte of data) {
    const factor: number = byte ^ (rem.shift() as number);
    rem.push(0);
    for (let j: number = 0; j < ec; j++) rem[j] ^= gf_mul(gen[j + 1] as number, factor);
  }
  return rem;
}

/* ------------------------------------------------------ the matrix */

/** A matrix of modules: true is dark. `fixed` marks function patterns. */
interface Matrix { size: number; dark: boolean[][]; fixed: boolean[][] }

function matrix_make(size: number): Matrix {
  return { size, dark: Array.from({ length: size }, (): boolean[] => new Array<boolean>(size).fill(false)), fixed: Array.from({ length: size }, (): boolean[] => new Array<boolean>(size).fill(false)) };
}

function module_set(m: Matrix, r: number, c: number, dark: boolean): void {
  (m.dark[r] as boolean[])[c] = dark;
  (m.fixed[r] as boolean[])[c] = true;
}

function finder_draw(m: Matrix, r0: number, c0: number): void {
  for (let r: number = -1; r <= 7; r++) {
    for (let c: number = -1; c <= 7; c++) {
      const rr: number = r0 + r; const cc: number = c0 + c;
      if (rr < 0 || cc < 0 || rr >= m.size || cc >= m.size) continue;
      const ring: number = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      module_set(m, rr, cc, ring !== 2 && ring !== 4);
    }
  }
}

function functions_draw(m: Matrix, version: number): void {
  finder_draw(m, 0, 0); finder_draw(m, 0, m.size - 7); finder_draw(m, m.size - 7, 0);
  for (let i: number = 8; i < m.size - 8; i++) {
    module_set(m, 6, i, i % 2 === 0);
    module_set(m, i, 6, i % 2 === 0);
  }
  const centres: ReadonlyArray<number> = ALIGNMENT[version] ?? [];
  const outer: number = centres[centres.length - 1] ?? -1;
  for (const r of centres) {
    for (const c of centres) {
      // The three that would sit on a finder (the first and the outermost
      // centres, paired) are left out; one on the timing pattern is drawn
      // over it, as the standard has it.
      if ((r === 6 && c === 6) || (r === 6 && c === outer) || (r === outer && c === 6)) continue;
      for (let dr: number = -2; dr <= 2; dr++) for (let dc: number = -2; dc <= 2; dc++) module_set(m, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  // The format areas are reserved now and written after the mask is chosen.
  for (let i: number = 0; i < 9; i++) {
    if (i !== 6) { module_set(m, 8, i, false); module_set(m, i, 8, false); }
  }
  for (let i: number = 0; i < 8; i++) { module_set(m, 8, m.size - 1 - i, false); module_set(m, m.size - 1 - i, 8, false); }
  module_set(m, m.size - 8, 8, true);
  if (version >= 7) {
    const bits: number = VERSION_BITS[version] as number;
    for (let i: number = 0; i < 18; i++) {
      const dark: boolean = ((bits >> i) & 1) === 1;
      module_set(m, Math.floor(i / 3), m.size - 11 + (i % 3), dark);
      module_set(m, m.size - 11 + (i % 3), Math.floor(i / 3), dark);
    }
  }
}

function format_draw(m: Matrix, mask: number): void {
  const bits: number = FORMAT_BITS[mask] as number;
  const bit = (i: number): boolean => ((bits >> i) & 1) === 1;
  // First copy: down column 8 beside the top-left finder, then along row 8.
  for (let i: number = 0; i <= 5; i++) module_set(m, i, 8, bit(i));
  module_set(m, 7, 8, bit(6)); module_set(m, 8, 8, bit(7)); module_set(m, 8, 7, bit(8));
  for (let i: number = 9; i < 15; i++) module_set(m, 8, 14 - i, bit(i));
  // Second copy: along row 8 under the top-right finder, down column 8 beside the bottom-left.
  for (let i: number = 0; i < 8; i++) module_set(m, 8, m.size - 1 - i, bit(i));
  for (let i: number = 8; i < 15; i++) module_set(m, m.size - 15 + i, 8, bit(i));
}

function mask_bit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function data_place(m: Matrix, codewords: number[], mask: number): void {
  let bitIndex: number = 0;
  const total: number = codewords.length * 8;
  let upward: boolean = true;
  for (let right: number = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step: number = 0; step < m.size; step++) {
      const r: number = upward ? m.size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if ((m.fixed[r] as boolean[])[c]) continue;
        let dark: boolean = false;
        if (bitIndex < total) {
          dark = ((codewords[bitIndex >> 3] as number) >> (7 - (bitIndex & 7)) & 1) === 1;
          bitIndex++;
        }
        if (mask_bit(mask, r, c)) dark = !dark;
        (m.dark[r] as boolean[])[c] = dark;
      }
    }
    upward = !upward;
  }
}

/** The penalty of a drawn matrix, by the four rules; lower is better. */
export function penalty_compute(dark: boolean[][]): number {
  const n: number = dark.length;
  let score: number = 0;
  const run = (line: boolean[]): void => {
    let count: number = 1;
    for (let i: number = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) { count++; continue; }
      if (count >= 5) score += 3 + (count - 5);
      count = 1;
    }
  };
  for (let i: number = 0; i < n; i++) { run(dark[i] as boolean[]); run(dark.map((row: boolean[]): boolean => row[i] as boolean)); }
  for (let r: number = 0; r < n - 1; r++) for (let c: number = 0; c < n - 1; c++) {
    const v: boolean = (dark[r] as boolean[])[c] as boolean;
    if (v === (dark[r] as boolean[])[c + 1] && v === (dark[r + 1] as boolean[])[c] && v === (dark[r + 1] as boolean[])[c + 1]) score += 3;
  }
  const pattern: boolean[] = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (line: boolean[], start: number, p: boolean[]): boolean => p.every((v: boolean, i: number): boolean => line[start + i] === v);
  const reversed: boolean[] = [...pattern].reverse();
  for (let i: number = 0; i < n; i++) {
    const row: boolean[] = dark[i] as boolean[];
    const col: boolean[] = dark.map((r: boolean[]): boolean => r[i] as boolean);
    for (let s: number = 0; s + 11 <= n; s++) {
      if (matches(row, s, pattern) || matches(row, s, reversed)) score += 40;
      if (matches(col, s, pattern) || matches(col, s, reversed)) score += 40;
    }
  }
  let darkCount: number = 0;
  for (const row of dark) for (const v of row) if (v) darkCount++;
  const percent: number = (darkCount * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * Encodes bytes as a QR matrix.
 *
 * @param text - The text (UTF-8).
 * @param maskForced - A mask to use instead of the least-penalty one (a test's seam).
 * @returns The dark/light matrix, its version and the mask chosen; null when too long.
 */
export function qr_encode(text: string, maskForced?: number): { size: number; dark: boolean[][]; version: number; mask: number } | null {
  const bytes: Buffer = Buffer.from(text, 'utf-8');
  let version: number = 0;
  for (let v: number = 1; v <= 10; v++) {
    const capacity: number = (DATA_CODEWORDS[v] as number) - (v >= 10 ? 3 : 2);
    if (bytes.length <= capacity) { version = v; break; }
  }
  if (version === 0) return null;
  const dataCount: number = DATA_CODEWORDS[version] as number;
  // The bit stream: mode 0100, the count (8 bits below version 10, 16 at it), the bytes, a terminator, padding.
  const bits: number[] = [];
  const push = (value: number, width: number): void => { for (let i: number = width - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCount * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i: number = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a: number, b: number): number => (a << 1) | b, 0));
  for (let pad: number = 0; data.length < dataCount; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11);
  // Blocks: the short ones first, then the long; interleaved for the stream.
  const blocks: number = BLOCKS[version] as number;
  const ec: number = EC_PER_BLOCK[version] as number;
  const shortLength: number = Math.floor(dataCount / blocks);
  const longBlocks: number = dataCount % blocks;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at: number = 0;
  for (let b: number = 0; b < blocks; b++) {
    const length: number = shortLength + (b >= blocks - longBlocks ? 1 : 0);
    const block: number[] = data.slice(at, at + length);
    at += length;
    dataBlocks.push(block);
    ecBlocks.push(rs_remainder(block, ec));
  }
  const codewords: number[] = [];
  for (let i: number = 0; i <= shortLength; i++) for (const block of dataBlocks) if (i < block.length) codewords.push(block[i] as number);
  for (let i: number = 0; i < ec; i++) for (const block of ecBlocks) codewords.push(block[i] as number);
  // Every mask drawn; the one with the least penalty stands.
  const size: number = 17 + version * 4;
  let best: { dark: boolean[][]; mask: number; penalty: number } | null = null;
  for (let mask: number = 0; mask < 8; mask++) {
    if (maskForced !== undefined && mask !== maskForced) continue;
    const m: Matrix = matrix_make(size);
    functions_draw(m, version);
    data_place(m, codewords, mask);
    format_draw(m, mask);
    const penalty: number = penalty_compute(m.dark);
    if (best === null || penalty < best.penalty) best = { dark: m.dark, mask, penalty };
  }
  return { size, dark: (best as { dark: boolean[][] }).dark, version, mask: (best as { mask: number }).mask };
}

/**
 * Draws a matrix in half blocks, light modules bright, a quiet zone round it.
 *
 * @param dark - The matrix.
 * @returns The lines.
 */
export function qr_render(dark: boolean[][]): string[] {
  const n: number = dark.length;
  const quiet: number = 2;
  const light = (r: number, c: number): boolean => r < 0 || c < 0 || r >= n || c >= n ? true : !((dark[r] as boolean[])[c] as boolean);
  const lines: string[] = [];
  for (let r: number = -quiet; r < n + quiet; r += 2) {
    let line: string = '';
    for (let c: number = -quiet; c < n + quiet; c++) {
      const top: boolean = light(r, c); const bottom: boolean = light(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines;
}


/** What a `qr` line may hold. */
const QR_GRAMMAR = {
  operands: [{ name: 'text', kind: 'word', optional: true, repeat: true, summary: 'The text or URL to encode (default: what is piped in)' }],
} as const satisfies CommandGrammar;

/**
 * `qr <text or URL>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [qrCommand] });
 * ```
 */
export const qrCommand = command_declare({
  name: 'qr',
  grammar: QR_GRAMMAR,
  help: {
    summary: 'A QR code in the console, for a phone',
    description: 'Draws a QR code of the text — a URL, mostly — in half-block characters, light modules bright so a phone camera reads it off a dark screen. Up to 271 bytes (QR versions 1 to 10, error correction L), encoded here with no library.',
    examples: ['qr https://titan.tch.harvard.edu', 'whereami | qr'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof QR_GRAMMAR>): Promise<CommandEnvelope> => qr_run(args.operands.text),
});

/**
 * `qr` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `qr`.
 * @returns The code, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_qr(['https://example.org']);
 * ```
 */
export async function builtin_qr(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(qrCommand, args);
}

/**
 * Draws a QR code of the piped text, else the words.
 *
 * @param words - The words given.
 * @returns The code drawn in half blocks, or a refusal when there is no text or too much.
 *
 * @example
 * ```ts
 * await qr_run(['https://example.org']);
 * ```
 */
export async function qr_run(words: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, 'qr: usage: qr <text or URL>   (up to 271 bytes)\n');
  const said: string = text.replace(/\n$/, '');
  const code = qr_encode(said);
  if (code === null) return envelope_error('', undefined, `qr: too long for the codes drawn here (${Buffer.byteLength(said, 'utf-8')} bytes; at most ${QR_MAX_BYTES})\n`);
  const rows: string[] = code.dark.map((row: boolean[]): string => row.map((d: boolean): string => (d ? '1' : '0')).join(''));
  return envelope_ok(`${qr_render(code.dark).join('\n')}\n`, { kind: 'games.qr', data: { text: said, version: code.version, size: code.size, rows } });
}
