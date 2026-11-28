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
  readonly pipes: readonly string[];
  readonly edits: readonly string[];
}

const TABLE: ReadonlyArray<TableLine> = (JSON.parse(readFileSync(new URL('./fixtures/hostLines.json', import.meta.url), 'utf8')) as { lines: TableLine[] }).lines;

describe('lineHostOperations_read', () => {
  it.each(TABLE.map((row: TableLine): [string, TableLine] => [row.line, row]))('%s', async (_line: string, row: TableLine) => {
    expect(await lineHostOperations_read(row.line)).toEqual({ shells: row.shells, pipes: row.pipes, edits: row.edits });
  });

  it('grants a later segment exactly as the engine hands it to the surface, and nothing for a builtin that does not delegate', async () => {
    expect((await lineHostOperations_read('cat x | tr a b')).pipes).toEqual(['tr a b']);
    expect((await lineHostOperations_read('cat x | wc -l')).pipes).toEqual([]);
  });

  it('grants nothing for what it cannot establish from the line: background, lists, captures, redirects, references, patterns, open quotes', async () => {
    for (const line of ['!ls &', 'ls && !rm x', 'ls || !rm x', 'ls; !rm x', 'X=$(ls | tr a b)', 'command ls > out', 'edit $F', 'command ls *.txt', 'cat x | grep "unclosed']) {
      expect([line, await lineHostOperations_read(line)]).toEqual([line, { shells: [], pipes: [], edits: [] }]);
    }
  });
});
