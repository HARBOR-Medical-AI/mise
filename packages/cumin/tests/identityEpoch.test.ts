/**
 * @file The identity epoch: which identity a piece of work was begun
 * under, and what the session's caches do with work begun under another.
 */
import {
  identityCache_usable,
  identityChange_listen,
  identityElevated_is,
  identityElevated_run,
  identityEpoch_get,
  identityOwned_make,
  identityScope_fork,
  identityScope_turn,
  identityEpoch_raise,
  identityScopeEpoch_get,
  identityScope_passed,
  identityScope_run,
} from '../src/connect/identityEpoch';
import { listCache_get, folderKey_spell } from '../src/cache/listCache';
import { procCache_get } from '../src/cache/procCache';
import { queryIndex_get } from '../src/cache/queryIndex';
import { listCheckpoint_restore, listCheckpoint_save, listCheckpoint_watch } from '../src/cache/listCheckpoint';
import { queryIndexCheckpoint_finish, queryIndexCheckpoint_hold, queryIndexCheckpoint_restore, queryIndexCheckpointPath_get } from '../src/cache/queryIndexCheckpoint';
import { procLayout_get, procLayout_set, procLayoutHome_set, procCheckpointDir_get } from '../src/cache/procCheckpoint';
import type { QueryIndexEntry } from '../src/cache/queryIndex';
import { mkdtempSync, existsSync, readdirSync, readFileSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Checkpoints kept "in the default place" by anything in this file go to a folder of the file's own, never
// to the cache of whoever runs the tests.
process.env['XDG_CACHE_HOME'] = mkdtempSync(join(tmpdir(), 'identity-cache-'));

/** A promise and the hand that settles it. */
function gate_make<T>(): { wait: Promise<T>; open: (value: T) => void } {
  let open: (value: T) => void = (): void => undefined;
  const wait: Promise<T> = new Promise((resolve: (value: T) => void): void => { open = resolve; });
  return { wait, open };
}

beforeEach(() => {
  listCache_get().cache_invalidate();
  procCache_get().cache_clear();
  queryIndex_get().reset();
});

describe('the epoch', () => {
  it('moves by one at each change, and tells every listener, which can be removed', () => {
    const heard: number[] = [];
    const stop: () => void = identityChange_listen((): void => { heard.push(identityEpoch_get()); });
    const before: number = identityEpoch_get();
    identityEpoch_raise();
    identityEpoch_raise();
    expect(identityEpoch_get()).toBe(before + 2);
    expect(heard).toEqual([before + 1, before + 2]);
    stop();
    identityEpoch_raise();
    expect(heard).toHaveLength(2);
  });

  it('work in a scope remembers the epoch it began under, and so does the work that made the change', async () => {
    const held = gate_make<void>();
    // Begun as the first identity, still running when the second connects.
    const old: Promise<{ usable: boolean; passed: boolean; epoch: number }> = identityScope_run(async () => {
      await held.wait;
      return { usable: identityCache_usable(), passed: identityScope_passed(), epoch: identityScopeEpoch_get() };
    });
    const began: number = identityEpoch_get();
    // The connect itself is a piece of work begun as the first: after the change it is stale too. What the
    // new identity fills is filled by work begun after the change.
    const connecting: { usable: boolean; epoch: number } = await identityScope_run(async () => {
      identityEpoch_raise();
      await Promise.resolve();
      return { usable: identityCache_usable(), epoch: identityScopeEpoch_get() };
    });
    expect(connecting).toEqual({ usable: false, epoch: began });
    expect(identityScope_run((): boolean => identityCache_usable())).toBe(true);
    held.open();
    expect(await old).toEqual({ usable: false, passed: true, epoch: began });
  });

  it('a fill that work started before it changed the identity itself is not kept, though both are in one scope', async () => {
    const answered = gate_make<string[]>();
    await identityScope_run(async () => {
      // A line that starts a lookup, and then connects as someone else while the lookup is out.
      const lookup: Promise<void> = (async (): Promise<void> => {
        listCache_get().cache_set('/bin', await answered.wait);
      })();
      identityEpoch_raise();
      answered.open(['the first one\'s plugin']);
      await lookup;
    });
    expect(listCache_get().cache_get('/bin')).toBeNull();
  });

  it('the line that connects hands on to its next command, and to nothing else: not to what it had started, not to what merely starts work later', async () => {
    const answered = gate_make<void>();
    let early: Promise<boolean> = Promise.resolve(true);
    let earlyInCommand: Promise<boolean> = Promise.resolve(true);
    const seen: { connecting: boolean; next: boolean; after: boolean } = await identityScope_turn(async () => {
      // A line of several commands, each begun in turn as the engine begins them. The line itself, and its
      // first command, each start something that is still out when the second command connects as someone else.
      early = (async (): Promise<boolean> => { await answered.wait; return identityScope_run((): boolean => identityCache_usable()); })();
      await identityScope_turn(async (): Promise<void> => {
        earlyInCommand = (async (): Promise<boolean> => { await answered.wait; return identityScope_run((): boolean => identityCache_usable()); })();
        await Promise.resolve();
      });
      const connecting: boolean = await identityScope_turn(async (): Promise<boolean> => { identityEpoch_raise('other@cube'); await Promise.resolve(); return identityCache_usable(); });
      // The next command of the same line is the new identity's: `connect other; ls` lists as the other.
      const next: boolean = await identityScope_turn(async (): Promise<boolean> => { await Promise.resolve(); return identityCache_usable(); });
      const after: boolean = await identityScope_turn((): boolean => identityCache_usable());
      return { connecting, next, after };
    });
    expect(seen).toEqual({ connecting: false, next: true, after: true });
    // What was started before the change stays the first one's, and so does the work it begins after it.
    answered.open();
    expect(await early).toBe(false);
    expect(await earlyInCommand).toBe(false);
  });

  it('a line handed on to one identity does not adopt another that unrelated work connects later', async () => {
    const elsewhere = gate_make<void>();
    const line: Promise<{ next: boolean; later: boolean; laterStill: boolean }> = identityScope_turn(async () => {
      await identityScope_turn(async (): Promise<void> => { identityEpoch_raise('second@cube'); await Promise.resolve(); });
      const next: boolean = await identityScope_turn((): boolean => identityCache_usable());
      await elsewhere.wait;
      const later: boolean = await identityScope_turn((): boolean => identityCache_usable());
      const laterStill: boolean = await identityScope_turn((): boolean => identityScope_run((): boolean => identityCache_usable()));
      return { next, later, laterStill };
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // Another line, on another surface, connects as a third.
    await identityScope_turn(async (): Promise<void> => { identityEpoch_raise('third@cube'); });
    elsewhere.open();
    // The first line's later commands are still the second's, which is no longer who is connected.
    expect(await line).toEqual({ next: true, later: false, laterStill: false });
  });

  it('a roster sync still out, and a feed that failed to load, are the one before\'s: the next identity is told of neither', () => {
    const cache = procCache_get();
    cache.rosterSync_progress('full');
    cache.feedLoad_fail(7, 'CUBE answered 503');
    expect(cache.rosterSync_get()).toBe('full');
    expect(cache.feedLoad_read(7)).not.toBeNull();
    identityEpoch_raise('other@cube');
    expect(procCache_get().rosterSync_get()).toBeNull();
    expect(procCache_get().feedLoad_read(7)).toBeNull();
  });

  it('work that goes on beside its beginner (a joblet, a watch) is a scope of its own: it is not handed on when its beginner connects', async () => {
    const answered = gate_make<void>();
    let beside: Promise<boolean> = Promise.resolve(true);
    await identityScope_run(async () => {
      beside = identityScope_fork(async (): Promise<boolean> => {
        await answered.wait;
        // It begins a piece of work of its own after the change, as a joblet runs its next line.
        return identityScope_run((): boolean => identityCache_usable());
      });
      identityEpoch_raise('other@cube');
    });
    answered.open();
    expect(await beside).toBe(false);
  });

  it('bookkeeping owned by an identity is made anew at a change, and other work has its own', async () => {
    const book_get = identityOwned_make((): { visited: Set<number> } => ({ visited: new Set<number>() }));
    book_get().visited.add(7);
    expect(book_get().visited.has(7)).toBe(true);
    // Work as another user starts with none of it, and what it adds is not the session's.
    await identityScope_run((): Promise<void> => identityElevated_run({ of: 'the admin' }, async (): Promise<void> => {
      expect(book_get().visited.size).toBe(0);
      book_get().visited.add(8);
      await Promise.resolve();
      expect(book_get().visited.has(8)).toBe(true);
    }));
    expect([...book_get().visited]).toEqual([7]);
    // Work begun before a change keeps none of the next identity's, and the next identity starts empty.
    const held = gate_make<void>();
    const old: Promise<number> = identityScope_run(async (): Promise<number> => { await held.wait; book_get().visited.add(9); return book_get().visited.size; });
    identityEpoch_raise('other@cube');
    expect(book_get().visited.size).toBe(0);
    held.open();
    expect(await old).toBe(1);
    expect(book_get().visited.size).toBe(0);
  });

  it('work already in a scope stays in it: stale work cannot make itself current by starting something', async () => {
    const held = gate_make<void>();
    const old: Promise<boolean> = identityScope_run(async () => {
      await held.wait;
      return identityScope_run((): boolean => identityCache_usable());
    });
    identityEpoch_raise();
    held.open();
    expect(await old).toBe(false);
  });

  it('work begun in no scope is taken as begun now', () => {
    identityEpoch_raise();
    expect(identityCache_usable()).toBe(true);
    expect(identityScope_passed()).toBe(false);
  });

  it('work done as another user is marked, for the length of that work only', async () => {
    expect(identityElevated_is()).toBe(false);
    const inside: { elevated: boolean; usable: boolean } = await identityElevated_run({ of: 'the admin' }, async () => {
      await Promise.resolve();
      return { elevated: identityElevated_is(), usable: identityCache_usable() };
    });
    expect(inside).toEqual({ elevated: true, usable: false });
    expect(identityElevated_is()).toBe(false);
    expect(identityCache_usable()).toBe(true);
  });
});

describe('the caches of one identity', () => {
  it('are emptied at a change: a listing, a folder record, the proc tree and the query index', () => {
    listCache_get().cache_set('/bin', [{ name: 'pl-a' }]);
    listCache_get().folder_set('/home/a', Promise.resolve({ id: 1 }));
    procCache_get().feed_add({ id: 7, name: 'f', owner: 'a' } as never);
    queryIndex_get().floor_set('2026-01-01T00:00:00Z');
    expect(listCache_get().cache_get('/bin')).not.toBeNull();
    identityEpoch_raise();
    expect(listCache_get().cache_get('/bin')).toBeNull();
    expect(listCache_get().folder_get('/home/a')).toBeNull();
    expect(procCache_get().feedIDs_get()).toEqual([]);
    expect(queryIndex_get().floor_get()).toBeNull();
  });

  it('a lookup begun as the first identity that finishes after the second has connected leaves nothing of the first', async () => {
    const answered = gate_make<Array<{ name: string }>>();
    // As the first: ask, and keep the answer when it comes.
    const first: Promise<void> = identityScope_run(async () => {
      const rows: Array<{ name: string }> = await answered.wait;
      listCache_get().cache_set('/bin', rows);
      listCache_get().folder_set('/home/a', Promise.resolve({ id: 1, of: 'the first' }));
      procCache_get().feed_add({ id: 7, name: 'the first one\'s feed', owner: 'a' } as never);
      queryIndex_get().floor_set('2026-01-01T00:00:00Z');
    });
    // The second connects while that is out.
    identityEpoch_raise();
    answered.open([{ name: 'the first one\'s plugin' }]);
    await first;
    // The second's own lookup finds nothing kept, and asks CUBE.
    await identityScope_run(async () => {
      expect(listCache_get().cache_get('/bin')).toBeNull();
      expect(listCache_get().folder_get('/home/a')).toBeNull();
      expect(procCache_get().feedIDs_get()).toEqual([]);
      expect(queryIndex_get().floor_get()).toBeNull();
      listCache_get().cache_set('/bin', [{ name: 'the second one\'s plugin' }]);
    });
    expect(listCache_get().cache_get<Array<{ name: string }>>('/bin')?.data).toEqual([{ name: 'the second one\'s plugin' }]);
  });

  it('a lookup as another user and an ordinary one of the same path, overlapping in either order, each have their own answer', async () => {
    for (const elevatedFirst of [true, false]) {
      listCache_get().cache_invalidate();
      const elevatedAnswer = gate_make<string[]>();
      const ordinaryAnswer = gate_make<string[]>();
      /** One lookup: what is kept if any, else what CUBE answers, kept after. */
      const lookup = async (answer: Promise<string[]>): Promise<string[]> => {
        const kept = listCache_get().cache_get<string[]>('/home/shared');
        if (kept !== null) return kept.data;
        const rows: string[] = await answer;
        listCache_get().cache_set('/home/shared', rows);
        return rows;
      };
      const elevated: Promise<string[]> = identityScope_run((): Promise<string[]> => identityElevated_run({ of: 'the admin' }, (): Promise<string[]> => lookup(elevatedAnswer.wait)));
      const ordinary: Promise<string[]> = identityScope_run((): Promise<string[]> => lookup(ordinaryAnswer.wait));
      if (elevatedFirst) { elevatedAnswer.open(['seen as admin']); await elevated; ordinaryAnswer.open(['seen as oneself']); }
      else { ordinaryAnswer.open(['seen as oneself']); await ordinary; elevatedAnswer.open(['seen as admin']); }
      expect(await elevated).toEqual(['seen as admin']);
      expect(await ordinary).toEqual(['seen as oneself']);
      // What is kept is the ordinary answer alone; and a later lookup as another user is not answered from it.
      expect(listCache_get().cache_get<string[]>('/home/shared')?.data).toEqual(['seen as oneself']);
      expect(await identityElevated_run({ of: 'the admin' }, (): Promise<string[]> => lookup(Promise.resolve(['seen as admin, again'])))).toEqual(['seen as admin, again']);
      expect(listCache_get().cache_get<string[]>('/home/shared')?.data).toEqual(['seen as oneself']);
    }
  });
});

describe('a folder record', () => {
  it('is one record however its path is spelled, and is dropped by an invalidation of any spelling', () => {
    expect([folderKey_spell('home/a'), folderKey_spell('/home/a'), folderKey_spell('/home/a/'), folderKey_spell('//home/a//')]).toEqual(['/home/a', '/home/a', '/home/a', '/home/a']);
    expect(folderKey_spell('/')).toBe('/');
    const record: Promise<unknown> = Promise.resolve({ id: 1 });
    listCache_get().folder_set('home/a', record);
    expect(listCache_get().folder_get('/home/a')).toBe(record);
    expect(listCache_get().folder_get('/home/a/')).toBe(record);
    expect(listCache_get().folders_count()).toBe(1);
    listCache_get().cache_invalidateTree('/home/a/');
    expect(listCache_get().folder_get('home/a')).toBeNull();
  });
});

describe('a checkpoint watcher', () => {
  it('writes nothing under its identity\'s name once another identity has connected', async () => {
    jest.useFakeTimers();
    try {
      const root: string = mkdtempSync(join(tmpdir(), 'identity-watch-'));
      const stop: () => void = listCheckpoint_watch('the-first@cube', root, 10, 0);
      // The second connects; what the cache then holds is the second's.
      identityEpoch_raise();
      listCache_get().cache_set('/bin', [{ name: 'the second one\'s plugin' }]);
      await jest.advanceTimersByTimeAsync(1000);
      expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
      stop();
      // (A watcher started for the identity now connected does write: the silence above is the first one's.)
      const second: string = mkdtempSync(join(tmpdir(), 'identity-watch-'));
      const stopSecond: () => void = listCheckpoint_watch('the-second@cube', second, 10, 0);
      listCache_get().cache_set('/bin', [{ name: 'another' }]);
      await jest.advanceTimersByTimeAsync(1000);
      jest.useRealTimers();
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      expect(readdirSync(second).length).toBeGreaterThan(0);
      stopSecond();
    } finally {
      jest.useRealTimers();
    }
  });
});

/** One PACS query as the index keeps it, told apart by its id and who asked. */
function query_make(queryId: number, owner: string): QueryIndexEntry {
  return { queryId, server: 'PACSDCM', criteria: { PatientID: String(queryId) }, owner, answeredAt: '2026-09-05T10:00:00.000Z', hasResult: true };
}

describe('the proc tree and the query index, for work that is not the session\'s own', () => {
  it('work done as another user builds and reads a tree of its own: it sees none of the session\'s, and leaves none behind', async () => {
    procCache_get().feed_add({ id: 7, name: 'the user\'s feed', owner: 'user' } as never);
    queryIndex_get().entry_note(query_make(1, 'user'));
    await identityScope_run((): Promise<void> => identityElevated_run({ of: 'the admin' }, async (): Promise<void> => {
      // Nothing of the session's is there to be read.
      expect(procCache_get().feedIDs_get()).toEqual([]);
      expect(procCache_get().feed_get(7)).toBeUndefined();
      expect(queryIndex_get().size_get()).toBe(0);
      // What it builds, it can read back, across a wait: the same tree for the whole of this piece of work.
      procCache_get().feed_add({ id: 7, name: 'the same number, as the admin sees it', owner: 'someone' } as never);
      procCache_get().feed_add({ id: 8, name: 'one only the admin sees', owner: 'someone' } as never);
      queryIndex_get().entry_note(query_make(2, 'admin'));
      await Promise.resolve();
      expect(procCache_get().feedIDs_get().sort()).toEqual([7, 8]);
      expect((procCache_get().feed_get(7) as { name?: string } | undefined)?.name).toBe('the same number, as the admin sees it');
      expect(queryIndex_get().has(2)).toBe(true);
    }));
    // The session's tree and index are as they were.
    expect(procCache_get().feedIDs_get()).toEqual([7]);
    expect((procCache_get().feed_get(7) as { name?: string } | undefined)?.name).toBe('the user\'s feed');
    expect(queryIndex_get().has(1)).toBe(true);
    expect(queryIndex_get().has(2)).toBe(false);
  });

  it('a build begun as the first identity, holding the cache from before the change, neither fills nor tidies the second\'s tree', async () => {
    const answered = gate_make<void>();
    const first: Promise<void> = identityScope_run(async (): Promise<void> => {
      // The cache as taken before the change: the very reference a build holds across its waits.
      const cache = procCache_get();
      cache.loading_set(7, Promise.resolve());
      await answered.wait;
      cache.feed_add({ id: 7, name: 'the first one\'s feed', owner: 'a' } as never);
      cache.topologyLoaded_mark(7);
      // Its tidying up, as a build's `finally` does it.
      cache.loading_clear(7);
      cache.warmup_complete();
    });
    identityEpoch_raise();
    // The second identity's own build of a feed with the same number is under way.
    const theirs: Promise<void> = Promise.resolve();
    await identityScope_run(async (): Promise<void> => {
      procCache_get().feed_add({ id: 7, name: 'the second one\'s feed', owner: 'b' } as never);
      procCache_get().loading_set(7, theirs);
    });
    answered.open();
    await first;
    expect((procCache_get().feed_get(7) as { name?: string } | undefined)?.name).toBe('the second one\'s feed');
    expect(procCache_get().topologyLoaded_has(7)).toBe(false);
    // The second's build in flight is still marked as in flight, and its warm-up is not called complete.
    expect(procCache_get().loading_get(7)).toBe(theirs);
    expect(procCache_get().warmupProgress_get().active === false && procCache_get().lifecycle_get().state).not.toBe('current');
  });

  it('what the operator had not yet looked at is forgotten with the identity: the next one, shown feeds of the same numbers, has no news of them', () => {
    const feeds_show = (): void => {
      procCache_get().feed_add({ id: 41, name: 'shared', owner: 'someone' } as never);
      procCache_get().feed_add({ id: 42, name: 'made public', owner: 'someone' } as never);
    };
    feeds_show();
    procCache_get().unseen_add([41, 42]);
    expect(procCache_get().unseen_get()).toEqual([41, 42]);
    // A plain clear of the index keeps the operator's memory of what is new: the same feeds, read again, are still news.
    procCache_get().cache_clear();
    feeds_show();
    expect(procCache_get().unseen_get()).toEqual([41, 42]);
    // A change of identity does not: it was that operator's memory.
    identityEpoch_raise();
    feeds_show();
    expect(procCache_get().unseen_get()).toEqual([]);
  });
});

describe('checkpoints through a change of identity', () => {
  it('a checkpoint still being read when the identity changes is not put into the next identity\'s cache', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'identity-restore-'));
    // The first identity's listings and queries, saved.
    listCache_get().cache_set('/bin', [{ name: 'the first one\'s plugin' }]);
    await listCheckpoint_save('first@cube', root);
    queryIndex_get().entry_note(query_make(1, 'first'));
    queryIndex_get().floor_set('2026-01-01T00:00:00.000Z');
    queryIndexCheckpoint_hold('first@cube', root);
    await queryIndexCheckpoint_finish('first@cube', root);
    listCache_get().cache_invalidate();
    queryIndex_get().reset();
    // Their restore is begun, and the disk is slow; the second connects before it answers.
    const read = fsp.readFile.bind(fsp);
    const slow = gate_make<void>();
    const readSpy = jest.spyOn(fsp, 'readFile').mockImplementation((async (...given: Parameters<typeof fsp.readFile>): Promise<unknown> => { await slow.wait; return read(...given); }) as never);
    try {
      const listings = listCheckpoint_restore('first@cube', root);
      const queries = queryIndexCheckpoint_restore('first@cube', root);
      identityEpoch_raise();
      slow.open();
      expect(await listings).toMatchObject({ restored: false, reason: 'the identity changed' });
      expect(await queries).toMatchObject({ restored: false, reason: 'the identity changed' });
    } finally {
      readSpy.mockRestore();
    }
    expect(listCache_get().cache_get('/bin')).toBeNull();
    expect(queryIndex_get().size_get()).toBe(0);
    expect(queryIndex_get().floor_get()).toBeNull();
  });

  it('each identity\'s queries and floor are in its own file at the end of a run in which the second connected part-way', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'identity-exit-'));
    const file = (identity: string): { identity: string; floor: string | null; entries: Array<{ queryId: number; owner: string }> } =>
      JSON.parse(readFileSync(queryIndexCheckpointPath_get(identity, root), 'utf8')) as { identity: string; floor: string | null; entries: Array<{ queryId: number; owner: string }> };
    // The second identity has a checkpoint from an earlier run, which this run must add to and not replace.
    queryIndex_get().entry_note(query_make(20, 'second'));
    queryIndexCheckpoint_hold('second@cube', root);
    await queryIndexCheckpoint_finish('second@cube', root);
    identityEpoch_raise();
    await queryIndexCheckpoint_finish(null, root);
    // This run begins as the first.
    queryIndexCheckpoint_hold('first@cube', root);
    queryIndex_get().entry_note(query_make(1, 'first'));
    queryIndex_get().entry_note(query_make(2, 'first'));
    queryIndex_get().floor_set('2026-03-01T00:00:00.000Z');
    // The second connects; nothing primes the index again.
    identityEpoch_raise();
    queryIndex_get().entry_note(query_make(21, 'second'));
    queryIndex_get().floor_set('2026-06-01T00:00:00.000Z');
    // The run ends.
    await queryIndexCheckpoint_finish('second@cube', root);
    const first = file('first@cube');
    const second = file('second@cube');
    expect(first.identity).toBe('first@cube');
    expect(first.entries.map((entry) => entry.queryId).sort()).toEqual([1, 2]);
    expect(first.floor).toBe('2026-03-01T00:00:00.000Z');
    expect(second.identity).toBe('second@cube');
    expect(second.entries.map((entry) => entry.queryId).sort()).toEqual([20, 21]);
    expect(second.floor).toBe('2026-06-01T00:00:00.000Z');
    expect([...first.entries, ...second.entries].every((entry) => (entry.queryId < 10) === (entry.owner === 'first'))).toBe(true);
  });

  it('three identities in one run, none primed after the first: each one\'s queries and floor are in its own file, added to what it had', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'identity-chain-'));
    const file = (identity: string): { floor: string | null; entries: Array<{ queryId: number }> } =>
      JSON.parse(readFileSync(queryIndexCheckpointPath_get(identity, root), 'utf8')) as { floor: string | null; entries: Array<{ queryId: number }> };
    const ids = (identity: string): number[] => file(identity).entries.map((entry) => entry.queryId).sort((a, b) => a - b);
    // The second and third already have checkpoints, from runs before this one.
    for (const [identity, queryId] of [['second@cube', 20], ['third@cube', 30]] as Array<[string, number]>) {
      identityEpoch_raise(identity);
      queryIndexCheckpoint_hold(identity, root);
      queryIndex_get().entry_note(query_make(queryId, identity));
      await queryIndexCheckpoint_finish(identity, root);
    }
    // This run: the first connects and is restored for; then the second connects, then the third. Each
    // makes a query in a command of the line that connected it, as a script does.
    identityEpoch_raise('first@cube');
    queryIndexCheckpoint_hold('first@cube', root);
    queryIndex_get().entry_note(query_make(1, 'first'));
    queryIndex_get().floor_set('2026-03-01T00:00:00.000Z');
    await identityScope_turn(async (): Promise<void> => {
      await identityScope_turn(async (): Promise<void> => { identityEpoch_raise('second@cube'); });
      await identityScope_turn(async (): Promise<void> => { queryIndex_get().entry_note(query_make(21, 'second')); queryIndex_get().floor_set('2026-04-01T00:00:00.000Z'); });
      await identityScope_turn(async (): Promise<void> => { identityEpoch_raise('third@cube'); });
      await identityScope_turn(async (): Promise<void> => { queryIndex_get().entry_note(query_make(31, 'third')); });
    });
    // The run ends, with nobody having said whose the index is since the first.
    await queryIndexCheckpoint_finish(null, root);
    expect(ids('first@cube')).toEqual([1]);
    expect(file('first@cube').floor).toBe('2026-03-01T00:00:00.000Z');
    expect(ids('second@cube')).toEqual([20, 21]);
    expect(file('second@cube').floor).toBe('2026-04-01T00:00:00.000Z');
    expect(ids('third@cube')).toEqual([30, 31]);
  });

  it('a watcher asked for by a warm-up whose identity has since been replaced is not installed: nothing of the next identity is saved under its name', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'identity-install-'));
    const queries = (identity: string): number[] => {
      try { return (JSON.parse(readFileSync(queryIndexCheckpointPath_get(identity, root), 'utf8')) as { entries: Array<{ queryId: number }> }).entries.map((entry) => entry.queryId); } catch { return []; }
    };
    identityEpoch_raise('first@cube');
    queryIndexCheckpoint_hold('first@cube', root);
    queryIndex_get().entry_note(query_make(1, 'first'));
    const slow = gate_make<void>();
    // The first identity's warm-up: its listings restore is slow, and it installs its watcher after it.
    const warmup: Promise<void> = identityScope_run(async (): Promise<void> => {
      await slow.wait;
      listCheckpoint_watch('first@cube', root, 5, 0);
      queryIndexCheckpoint_hold('first@cube', root);
    });
    identityEpoch_raise('second@cube');
    slow.open();
    await warmup;
    // The second's listings and queries change.
    jest.useFakeTimers();
    try {
      listCache_get().cache_set('/bin', [{ name: 'the second one\'s plugin' }]);
      queryIndex_get().entry_note(query_make(21, 'second'));
      await jest.advanceTimersByTimeAsync(500);
    } finally {
      jest.useRealTimers();
    }
    await queryIndexCheckpoint_finish(null, root);
    // No listing checkpoint was written at all (the only watcher asked for was the first's, after it had left).
    expect(readdirSync(root).filter((name: string): boolean => name.startsWith('listings-'))).toEqual([]);
    // The first's queries are the first's, written as it left; the second's are in the second's file.
    expect(queries('first@cube')).toEqual([1]);
    expect(queries('second@cube')).toEqual([21]);
  });

  it('a layout is the identity\'s whose home it was kept in: after a change there is none, and none is written into the old home', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'identity-layout-'));
    procLayoutHome_set({ identity: 'first@cube', root });
    await procLayout_set('galaxy', { 'feed:1:0': [1, 2, 3] });
    expect((await procLayout_get('galaxy'))?.positions).toEqual({ 'feed:1:0': [1, 2, 3] });
    const before: string[] = readdirSync(procCheckpointDir_get('first@cube', root)).sort();
    identityEpoch_raise();
    // The second has no layout of that name, and what it sets is not written under the first's name.
    expect(await procLayout_get('galaxy')).toBeNull();
    await procLayout_set('galaxy', { 'feed:9:0': [9, 9, 9] });
    expect(readdirSync(procCheckpointDir_get('first@cube', root)).sort()).toEqual(before);
    expect(JSON.parse(readFileSync(join(procCheckpointDir_get('first@cube', root), 'layout-galaxy.json'), 'utf8')).positions).toEqual({ 'feed:1:0': [1, 2, 3] });
    // Work done as another user is handed no layout of the session's, and keeps none.
    procLayoutHome_set({ identity: 'second@cube', root });
    await procLayout_set('galaxy', { 'feed:9:0': [9, 9, 9] });
    expect(await identityElevated_run({ of: 'the admin' }, (): Promise<unknown> => procLayout_get('galaxy'))).toBeNull();
    procLayoutHome_set(null);
  });
});
