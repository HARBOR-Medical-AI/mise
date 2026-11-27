/**
 * @file The query checkpoint from a cold start: a process that has not
 * touched the query index before somebody else connects, a name typed in
 * mixed case, and a kept file that cannot be read.
 *
 * Nothing here resets the index or the epoch before a case: the first
 * case is the module as a fresh process loads it.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Anything kept "in the default place" goes to a folder of this file's own.
process.env['XDG_CACHE_HOME'] = mkdtempSync(join(tmpdir(), 'coldstart-cache-'));

import { identityEpoch_raise, identityName_spell, identityScope_turn } from '../src/connect/identityEpoch';
import { queryIndexCheckpoint_finish, queryIndexCheckpoint_hold, queryIndexCheckpointPath_get } from '../src/cache/queryIndexCheckpoint';
import { queryIndex_get, type QueryIndexEntry } from '../src/cache/queryIndex';

function query_make(queryId: number, owner: string): QueryIndexEntry {
  return { queryId, server: 'PACSDCM', criteria: { PatientID: String(queryId) }, owner, answeredAt: '2026-09-05T10:00:00.000Z', hasResult: true };
}

function ids_read(identity: string, root: string): number[] {
  const file = JSON.parse(readFileSync(queryIndexCheckpointPath_get(identity, root), 'utf8')) as { entries: Array<{ queryId: number }> };
  return file.entries.map((entry) => entry.queryId).sort((a, b) => a - b);
}

describe('the query checkpoint from a cold start', () => {
  it('a one-shot with no checkpoint whose line connects as another before its first query writes that query under the other\'s name', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'coldstart-'));
    const first: string = identityName_spell('first', 'https://cube/api/v1/');
    const second: string = identityName_spell('second', 'https://cube/api/v1/');
    // The first is connected; there is no checkpoint to restore, and the index is held as theirs. Nothing
    // has asked for the index yet.
    queryIndexCheckpoint_hold(first, root);
    await identityScope_turn(async (): Promise<void> => {
      await identityScope_turn(async (): Promise<void> => { identityEpoch_raise(second); });
      // The first use of the index in this process, by the second.
      await identityScope_turn(async (): Promise<void> => { queryIndex_get().entry_note(query_make(21, 'second')); });
    });
    await queryIndexCheckpoint_finish(second, root);
    expect(ids_read(second, root)).toEqual([21]);
    // The first learnt nothing: whatever is kept for it holds none of the second's.
    expect(existsSync(queryIndexCheckpointPath_get(first, root)) ? ids_read(first, root) : []).toEqual([]);
  });

  it('one user at one CUBE is one name, however the address was typed', () => {
    expect(identityName_spell('Chris', 'HTTPS://Cube.Example:8000/Api/v1/')).toBe('Chris@https://cube.example:8000/Api/v1/');
    expect(identityName_spell('chris', 'no-scheme/Path')).toBe('chris@no-scheme/Path');
    const root: string = '/somewhere';
    expect(queryIndexCheckpointPath_get(identityName_spell('chris', 'HTTP://CUBE/api/v1/'), root))
      .toBe(queryIndexCheckpointPath_get(identityName_spell('chris', 'http://cube/api/v1/'), root));
  });

  it('a kept file that cannot be read is not written over with only this run\'s entries', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'coldstart-unreadable-'));
    const third: string = identityName_spell('third', 'https://cube/api/v1/');
    const fourth: string = identityName_spell('fourth', 'https://cube/api/v1/');
    const path: string = queryIndexCheckpointPath_get(third, root);
    const kept: string = `${JSON.stringify({ schemaVersion: 1, identity: third, writtenAt: '2026-01-01T00:00:00.000Z', floor: null, entries: [query_make(30, 'third')] })}\n`;
    writeFileSync(path, kept, { mode: 0o600 });
    // The third connects in this run without its checkpoint having been restored, and learns a query.
    identityEpoch_raise(third);
    queryIndex_get().entry_note(query_make(31, 'third'));
    chmodSync(path, 0o000);
    try {
      // It leaves: its index is to be added to its file, and the file cannot be read.
      identityEpoch_raise(fourth);
      await queryIndexCheckpoint_finish(fourth, root);
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readFileSync(path, 'utf8')).toBe(kept);
  });
});
