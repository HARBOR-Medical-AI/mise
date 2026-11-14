/**
 * @file Unit tests for the extracted `du` helpers.
 *
 * Covers the pure logic carved out of `builtin_du`: flag parsing against its declaration, size
 * formatting, and the per-directory size attribution walk. Cross-package and
 * IO dependencies are mocked so the module loads in isolation.
 *
 * @module
 */
import { jest, describe, it, expect } from '@jest/globals';
import type { ScanRecord } from '@fnndsc/chili/path/pathCommand.js';
import type { DuOptions } from '../src/builtins/fs/du.js';

jest.unstable_mockModule('@fnndsc/chili/commands/fs/upload.js', () => ({
  bytes_format: (n: number) => `${n}B`,
}));
jest.unstable_mockModule('@fnndsc/chili/path/pathCommand.js', () => ({
  scan_do: jest.fn(),
}));
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: jest.fn(), setCWD: jest.fn() },
}));
jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({ vfs: { data_get: jest.fn() } }));
jest.unstable_mockModule('../src/lib/spinner.js', () => ({ spinner: { start: jest.fn(), stop: jest.fn() } }));

const { duSize_format, dirSizes_compute, duCommand } = await import('../src/builtins/fs/du.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { shellWord_literal } = await import('../src/lib/parser.js');

/**
 * Parses du's words against its declaration.
 *
 * @param words - The words after `du`.
 * @returns The parse.
 */
function line_parse(words: string[]): ReturnType<typeof commandLine_parse> {
  return commandLine_parse(duCommand, words.map(shellWord_literal));
}

/**
 * du's options as its handler hands them to the walk.
 *
 * @param words - The words after `du`.
 * @returns The options.
 */
async function options_parse(words: string[]): Promise<DuOptions> {
  const parsed = await line_parse(words);
  if (!parsed.ok) throw new Error(parsed.refusal);
  const options = parsed.args.options as Record<string, unknown>;
  return {
    humanReadable: options['humanReadable'] as boolean,
    summarize: options['summarize'] as boolean,
    showAll: options['all'] as boolean,
    showTotal: options['total'] as boolean,
    separateDirs: options['separateDirs'] as boolean,
    maxDepth: options['maxDepth'] as number | undefined,
  };
}
function file(chrisPath: string, size: number) {
  return { id: 0, hostPath: '', chrisPath, size, isLink: false, linkTarget: '', isDirectory: false };
}
function dir(chrisPath: string) {
  return { id: 0, hostPath: '', chrisPath, size: 0, isLink: false, linkTarget: '', isDirectory: true };
}
function scan(fileInfo: ReturnType<typeof file>[], totalSize: number): ScanRecord {
  return { fileInfo, totalSize } as unknown as ScanRecord;
}

const DEFAULTS: DuOptions = {
  humanReadable: false,
  summarize: false,
  showAll: false,
  showTotal: false,
  separateDirs: false,
  maxDepth: undefined,
};

describe('duSize_format', () => {
  it('formats raw bytes as ceil-KB, right-aligned to 12', () => {
    expect(duSize_format(2048, false)).toBe('           2');
    expect(duSize_format(1, false)).toBe('           1');
  });
  it('uses the human-readable formatter when requested, padded to 12', () => {
    const out = duSize_format(1048576, true);
    expect(out.length).toBe(12);
    expect(out.trim()).toBe('1048576B');
  });
});

describe('du\'s options, parsed against its declaration', () => {
  it('defaults all flags to false / undefined', async () => {
    expect(await options_parse([])).toEqual(DEFAULTS);
  });
  it('reads short flags', async () => {
    expect(await options_parse(['-h', '-s', '-a', '-c', '-S', '-d', '3'])).toEqual({
      humanReadable: true, summarize: true, showAll: true, showTotal: true, separateDirs: true, maxDepth: 3,
    });
  });
  it('reads long-form aliases', async () => {
    const o = await options_parse(['--human-readable', '--max-depth', '2', '--summarize']);
    expect(o.humanReadable).toBe(true);
    expect(o.maxDepth).toBe(2);
    expect(o.summarize).toBe(true);
  });
});

describe('dirSizes_compute', () => {
  const tree = scan([
    dir('/a/b'), dir('/a/c'),
    file('/a/b/f1', 100), file('/a/b/f2', 200), file('/a/c/f3', 50),
  ], 350);

  it('attributes file sizes to each ancestor up to the target', () => {
    const m = dirSizes_compute(tree, '/a', DEFAULTS);
    expect(m.get('/a/b')).toBe(300);
    expect(m.get('/a/c')).toBe(50);
    expect(m.get('/a')).toBe(350);
  });
  it('with showAll, individual files appear as entries', () => {
    const m = dirSizes_compute(tree, '/a', { ...DEFAULTS, showAll: true });
    expect(m.get('/a/b/f1')).toBe(100);
    expect(m.get('/a/c/f3')).toBe(50);
  });
  it('with separateDirs, only the immediate parent is charged (no ancestors)', () => {
    const deep = scan([dir('/x/y'), dir('/x/y/z'), file('/x/y/z/f', 10)], 10);
    expect(dirSizes_compute(deep, '/x', DEFAULTS).get('/x/y')).toBe(10);
    expect(dirSizes_compute(deep, '/x', { ...DEFAULTS, separateDirs: true }).get('/x/y')).toBe(0);
  });
  it('falls back to totalSize for the target when no files land in it', () => {
    expect(dirSizes_compute(scan([], 999), '/root', DEFAULTS).get('/root')).toBe(999);
  });
});

describe('du\'s depth', () => {
  it('takes -d N and -dN as --max-depth=N, and after -- a word is a path', async () => {
    const spaced = await line_parse(['-d', '1', '~/csv']);
    expect(spaced.ok && [spaced.args.options['maxDepth'], spaced.args.operands['path']]).toEqual([1, ['~/csv']]);
    const glued = await line_parse(['-d0', '-h', 'x']);
    expect(glued.ok && [glued.args.options['maxDepth'], glued.args.options['humanReadable'], glued.args.operands['path']]).toEqual([0, true, ['x']]);
    const ended = await line_parse(['--', '-d', '1']);
    expect(ended.ok && [ended.args.options['maxDepth'], ended.args.operands['path']]).toEqual([undefined, ['-d', '1']]);
  });
});
