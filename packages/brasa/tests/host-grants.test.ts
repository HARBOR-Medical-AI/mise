/**
 * @file What a line asks the machine it was typed on to run, read without running it: the real reader, with the
 * engine's core commands registered, held to the table a surface's tests share.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { cuminMock_install } from './support/cuminMock.js';

cuminMock_install(() => ({}));
// The core commands register as the engine loads: which later segments are builtins is the engine's own answer.
await import('../src/core/dispatch.js');
const { lineHostOperations_read } = await import('../src/builtins/sys/hostGrants.js');

/** One line of the shared table. */
interface TableLine {
  readonly line: string;
  readonly shells: readonly string[];
  readonly pipes: ReadonlyArray<{ command: string; required: boolean }>;
  readonly edits: readonly string[];
}

const TABLE: ReadonlyArray<TableLine> = (JSON.parse(readFileSync(new URL('./fixtures/hostLines.json', import.meta.url), 'utf8')) as { lines: TableLine[] }).lines;

describe('lineHostOperations_read', () => {
  it.each(TABLE.map((row: TableLine): [string, TableLine] => [row.line, row]))('%s', async (_line: string, row: TableLine) => {
    expect(await lineHostOperations_read(row.line)).toEqual({ shells: row.shells, pipes: row.pipes, edits: row.edits });
  });

  it('grants a later segment exactly as the engine hands it to the surface, and nothing for a builtin that does not delegate', async () => {
    expect((await lineHostOperations_read('cat x | tr a b')).pipes).toEqual([{ command: 'tr a b', required: true }]);
    expect((await lineHostOperations_read('cat x | wc -l')).pipes).toEqual([]);
  });

  it('routes by the session\'s own words: a word it runs grants nothing, and a session that said none grants no pipeline', async () => {
    const sessionRuns = (word: string): boolean => word === 'cat' || word === 'tr';
    expect((await lineHostOperations_read('cat x | tr a b | sort', sessionRuns)).pipes).toEqual([{ command: 'sort', required: true }]);
    expect(await lineHostOperations_read('cat x | tr a b', null)).toEqual({ shells: [], pipes: [], edits: [] });
    // A `!` line and an edit do not depend on the session's words.
    expect((await lineHostOperations_read('!ls', null)).shells).toEqual(['ls']);
  });

  it('grants a head grep nothing (its input is the line\'s own), a builtin at its help nothing, and a segment holding a reference nothing', async () => {
    expect((await lineHostOperations_read('grep foo | tr a b')).pipes).toEqual([{ command: 'tr a b', required: true }]);
    expect((await lineHostOperations_read('cat x | grep --help')).pipes).toEqual([]);
    expect(await lineHostOperations_read('cat x | tr $A b')).toEqual({ shells: [], pipes: [], edits: [] });
    expect((await lineHostOperations_read("cat x | tr '$A' b")).pipes).toEqual([{ command: "tr '$A' b", required: true }]);
  });

  it('grants nothing for what it cannot establish from the line: background, lists, captures, redirects, references, patterns, open quotes', async () => {
    for (const line of ['!ls &', 'ls && !rm x', 'ls || !rm x', 'ls; !rm x', 'X=$(ls | tr a b)', 'command ls > out', 'edit $F', 'command ls *.txt', 'cat x | grep "unclosed']) {
      expect([line, await lineHostOperations_read(line)]).toEqual([line, { shells: [], pipes: [], edits: [] }]);
    }
  });
});
