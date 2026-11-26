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
  identityEpoch_raise,
  identityScopeEpoch_get,
  identityScope_passed,
  identityScope_run,
} from '../src/connect/identityEpoch';
import { listCache_get, folderKey_spell } from '../src/cache/listCache';
import { procCache_get } from '../src/cache/procCache';
import { queryIndex_get } from '../src/cache/queryIndex';
import { listCheckpoint_watch } from '../src/cache/listCheckpoint';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('work in a scope remembers the epoch it began under; work that made the change carries on under the new one', async () => {
    const held = gate_make<void>();
    // Begun as the first identity, still running when the second connects.
    const old: Promise<{ usable: boolean; passed: boolean; epoch: number }> = identityScope_run(async () => {
      await held.wait;
      return { usable: identityCache_usable(), passed: identityScope_passed(), epoch: identityScopeEpoch_get() };
    });
    const began: number = identityEpoch_get();
    // The connect itself: one piece of work that changes the identity and then goes on.
    const connecting: { usable: boolean; epoch: number } = await identityScope_run(async () => {
      identityEpoch_raise();
      await Promise.resolve();
      return { usable: identityCache_usable(), epoch: identityScopeEpoch_get() };
    });
    expect(connecting).toEqual({ usable: true, epoch: began + 1 });
    held.open();
    expect(await old).toEqual({ usable: false, passed: true, epoch: began });
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
