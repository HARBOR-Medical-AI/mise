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
jest.unstable_mockModule('@fnndsc/salsa', () => ({ files_path_isDirectory: async (): Promise<boolean> => false, files_listRecursive: async () => [] }));
jest.unstable_mockModule('../src/builtins/fs/archive.js', () => ({ directory_archive: async () => null }));
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  errorStack: { stack_pop: () => undefined, stack_getAll: () => [] },
}));

const { deliveryIntents_read, deliveryIntent_matches, deliverySource_matches, sourceIntents_settle } = await import('../src/builtins/fs/deliveryIntent.js');
const { commandOperands_place } = await import('../src/core/commandParse.js');
const { downloadCommand } = await import('../src/builtins/fs/download.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

/** One line of the shared table. */
interface TableLine {
  readonly line: string;
  readonly intents: ReadonlyArray<{ verb: string; destination: string | null; unbound?: string }>;
}

// A null `unbound` is never written to the table; an absent one and the reader's undefined compare equal.
const TABLE: ReadonlyArray<TableLine> = (JSON.parse(readFileSync(new URL('./fixtures/deliveryLines.json', import.meta.url), 'utf8')) as { lines: TableLine[] }).lines;

describe('deliveryIntents_read', () => {
  it.each(TABLE.map((row: TableLine): [string, TableLine] => [row.line, row]))('%j', (_line: string, row: TableLine) => {
    expect(deliveryIntents_read(row.line, 'chris')).toEqual(row.intents);
  });
});

describe('deliveryIntents_read, by the session\'s backend', () => {
  it.each(TABLE.map((row: TableLine): [string] => [row.line]))('%j asks for nothing in a stratus session, which has no download, nor in one that names no backend', (line: string) => {
    expect(deliveryIntents_read(line, 'stratus')).toEqual([]);
    expect(deliveryIntents_read(line, undefined)).toEqual([]);
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

  it('an intent that cannot be bound matches nothing, not even the spelling it was written with', () => {
    const unbound = deliveryIntents_read('download /a $OUT', 'chris');
    expect(unbound).toHaveLength(1);
    expect(unbound[0]?.unbound).toContain('written with a reference');
    expect(deliveryIntent_matches(unbound, '$OUT')).toBe(false);
    expect(deliveryIntent_matches(unbound, undefined)).toBe(false);
    expect(deliveryIntent_matches(unbound, '/data/out')).toBe(false);
    // The same letters, quoted so they are text, are a place like any other.
    expect(deliveryIntent_matches(deliveryIntents_read("download /a '$OUT'", 'chris'), '$OUT')).toBe(true);
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

describe('deliverySource_matches', () => {
  const file = (path: string, filename: string, source: string | undefined) => ({ path, filename, source });
  /** The sources of a line as chell settles them, against a session folder it showed. */
  const settled = (line: string, cwd: string | null = '/home/me') => sourceIntents_settle(deliveryIntents_read(line, 'chris'), cwd)[0]?.sources ?? [];

  it('a file is the source the line typed: absolute exactly, relative under the session folder shown', () => {
    expect(deliverySource_matches(settled('download /home/me/scan.dcm ./out'), file('/home/me/scan.dcm', 'scan.dcm', '/home/me/scan.dcm'))).toBe(true);
    expect(deliverySource_matches(settled('download scan.dcm ./out'), file('/home/me/scan.dcm', 'scan.dcm', '/home/me/scan.dcm'))).toBe(true);
    // The same name under another root, or a relative name whose tail a foreign root shares, is not it.
    expect(deliverySource_matches(settled('download /home/me/scan.dcm ./out'), file('/home/eve/scan.dcm', 'scan.dcm', '/home/eve/scan.dcm'))).toBe(false);
    expect(deliverySource_matches(settled('download scan.dcm ./out'), file('/home/eve/scan.dcm', 'scan.dcm', '/home/eve/scan.dcm'))).toBe(false);
    expect(deliverySource_matches(settled('download /home/me/scan.dcm ./out'), file('/home/me/scan.dcm', 'renamed.dcm', '/home/me/scan.dcm'))).toBe(false);
    expect(deliverySource_matches(settled('download /home/me/scan.dcm ./out'), file('/home/me/scan.dcm', 'scan.dcm', undefined))).toBe(false);
  });

  it('a relative source with no session folder shown binds nothing; spellings of the same path bind alike', () => {
    expect(sourceIntents_settle(deliveryIntents_read('download scan.dcm ./out', 'chris'), null)[0]?.unbound).toContain('no session folder has been shown here');
    for (const line of ['download ././scan.dcm ./out', 'download scan.dcm/ ./out', 'download .//scan.dcm ./out']) {
      expect([line, deliverySource_matches(settled(line), file('/home/me/scan.dcm', 'scan.dcm', '/home/me/scan.dcm'))]).toEqual([line, true]);
    }
    // `./` alone is the session folder, as `.` is: only the session knows it.
    expect(deliveryIntents_read('download ./ ./out', 'chris')[0]?.unbound).toContain('names a place only the session knows');
  });

  it('a folder\'s file is under the root and written by its path inside it; the store root binds its own files', () => {
    expect(deliverySource_matches(settled('download scans ./out'), file('/home/me/scans/a/1.dcm', 'a/1.dcm', '/home/me/scans'))).toBe(true);
    expect(deliverySource_matches(settled('download scans ./out'), file('/home/me/scans/a/1.dcm', '1.dcm', '/home/me/scans'))).toBe(false);
    expect(deliverySource_matches(settled('download scans ./out'), file('/home/me/other/a/1.dcm', 'a/1.dcm', '/home/me/scans'))).toBe(false);
    expect(deliverySource_matches(settled('download / ./out'), file('/scan.dcm', 'scan.dcm', '/'))).toBe(true);
  });

  it('a pattern binds a root whose name matches it in the folder it names, trailing slash or not; a written name never climbs', () => {
    expect(deliverySource_matches(settled('download /home/me/*.dcm ./out'), file('/home/me/x.dcm', 'x.dcm', '/home/me/x.dcm'))).toBe(true);
    expect(deliverySource_matches(settled('download /home/me/*.dcm ./out'), file('/home/eve/x.dcm', 'x.dcm', '/home/eve/x.dcm'))).toBe(false);
    expect(deliverySource_matches(settled('download scans/*/ ./out'), file('/home/me/scans/s1/a.dcm', 'a.dcm', '/home/me/scans/s1'))).toBe(true);
    for (const filename of ['../x', '/etc/passwd', 'a/../../x', '', 'a//b', './x']) {
      expect([filename, deliverySource_matches(settled('download /home/me ./out'), file(`/home/me/${filename}`, filename, '/home/me'))]).toEqual([filename, false]);
    }
  });
});
