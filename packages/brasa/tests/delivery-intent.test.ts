/**
 * @file What a line asks to have delivered, read without running it: the
 * real reader, driven by `download`'s own declaration, held to the table
 * a surface's tests share; and the match a delivery is honoured by.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { cuminMock_install } from './support/cuminMock.js';

// `download`'s module reaches the store, the transfer and the session; none
// of it runs here. Its declaration is what is under test, so the rest is
// stood in for, as download-builtin.test.ts does. The line parser is real.
jest.unstable_mockModule('@fnndsc/chili/commands/fs/download.js', () => ({
  files_downloadWithProgress: jest.fn(),
  files_downloadManyWithProgress: jest.fn(),
  bytes_format: (bytes: number): string => `${bytes} B`,
}));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ storePath_resolve: async (input: string): Promise<string> => input }));
jest.unstable_mockModule('../src/core/surface.js', () => ({ surface_get: () => ({ capabilities: {} }) }));
jest.unstable_mockModule('../src/core/sink.js', () => ({ sink_get: () => ({ status_write: jest.fn(), err_write: jest.fn(), progress_write: jest.fn() }) }));
jest.unstable_mockModule('../src/core/question.js', () => ({ repl_confirm: async (): Promise<boolean> => true }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ files_path_isDirectory: async (): Promise<boolean> => false, files_listRecursive: async () => [] }));
jest.unstable_mockModule('../src/builtins/fs/archive.js', () => ({ directory_archive: async () => null }));
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  errorStack: { stack_pop: () => undefined, stack_getAll: () => [] },
}));

const { deliveryIntents_read, deliveryIntent_matches } = await import('../src/builtins/fs/deliveryIntent.js');
const { commandOperands_place } = await import('../src/core/commandParse.js');
const { downloadCommand } = await import('../src/builtins/fs/download.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

/** One line of the shared table. */
interface TableLine {
  readonly line: string;
  readonly intents: ReadonlyArray<{ verb: string; destination: string | null }>;
}

const TABLE: ReadonlyArray<TableLine> = (JSON.parse(readFileSync(new URL('./fixtures/deliveryLines.json', import.meta.url), 'utf8')) as { lines: TableLine[] }).lines;

describe('deliveryIntents_read', () => {
  it.each(TABLE.map((row: TableLine): [string, TableLine] => [row.line, row]))('%j', (_line: string, row: TableLine) => {
    expect(deliveryIntents_read(row.line)).toEqual(row.intents);
  });
});

describe('commandOperands_place', () => {
  it('gives each operand its words by the declaration, options set aside, nothing expanded', () => {
    const placed = commandOperands_place(downloadCommand, shellWords_tokenize('-f -j 8 /a/*.nii /b "./my folder"'));
    expect(placed?.get('source')?.map((word) => word.value)).toEqual(['/a/*.nii', '/b']);
    expect(placed?.get('destination')?.map((word) => word.value)).toEqual(['./my folder']);
  });

  it('answers null for a line the declaration refuses', () => {
    expect(commandOperands_place(downloadCommand, shellWords_tokenize('/only'))).toBeNull();
    expect(commandOperands_place(downloadCommand, shellWords_tokenize('--nosuch /a /b'))).toBeNull();
  });
});

describe('deliveryIntent_matches', () => {
  const intents = [{ verb: 'download', destination: './scans' }];

  it('matches the destination a line named, exactly', () => {
    expect(deliveryIntent_matches(intents, './scans')).toBe(true);
    expect(deliveryIntent_matches(intents, './scans/')).toBe(false);
    expect(deliveryIntent_matches(intents, 'scans')).toBe(false);
    expect(deliveryIntent_matches(intents, '/home/me/.ssh')).toBe(false);
  });

  it('a delivery with no destination matches only an intent with none', () => {
    expect(deliveryIntent_matches(intents, undefined)).toBe(false);
    expect(deliveryIntent_matches(intents, '')).toBe(false);
    expect(deliveryIntent_matches([{ verb: 'x', destination: null }], undefined)).toBe(true);
  });

  it('no intent matches nothing', () => {
    expect(deliveryIntent_matches([], './scans')).toBe(false);
    expect(deliveryIntent_matches([], undefined)).toBe(false);
  });
});

describe('every command that asks a surface to write a file is one the reader knows', () => {
  it('only download.ts calls the surface\'s fileDeliver', async () => {
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root: string = new URL('../src', import.meta.url).pathname;
    const callers: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const at: string = join(folder, entry.name);
        if (entry.isDirectory()) walk(at);
        else if (entry.name.endsWith('.ts') && /\.fileDeliver\(/.test(readFileSync(at, 'utf8'))) callers.push(at.slice(root.length + 1));
      }
    };
    walk(root);
    expect(callers).toEqual(['builtins/fs/download.ts']);
  });
});
