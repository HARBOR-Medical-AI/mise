/**
 * The transfer pool: bounded at `jobs`, totals that do not depend on the
 * order files end in, one retry, failures by item, a cancel that stops
 * every worker, and notes kept per attempt.
 */
import { errorStack } from '@fnndsc/fond';
import {
  TRANSFER_JOBS_DEFAULT, TRANSFER_JOBS_MAX, transferJobs_check, transferPool_run,
  type TransferPoolResult, type TransferSettled,
} from '../src/io/transferPool';

/** A promise the test resolves by hand. */
interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate_make(): Gate {
  let open: () => void = (): void => undefined;
  const promise: Promise<void> = new Promise<void>((resolve: () => void): void => { open = resolve; });
  return { promise, open };
}

function tick(ms: number = 0): Promise<void> {
  return new Promise<void>((resolve: () => void): void => { setTimeout(resolve, ms); });
}

beforeEach(() => {
  errorStack.stack_clear();
});

describe('transferJobs_check', () => {
  it('takes 1 to 32 and refuses the rest in a few words', () => {
    expect(TRANSFER_JOBS_DEFAULT).toBe(8);
    expect(TRANSFER_JOBS_MAX).toBe(32);
    expect(transferJobs_check(1)).toBeNull();
    expect(transferJobs_check(32)).toBeNull();
    expect(transferJobs_check(0)).toBe('at least 1');
    expect(transferJobs_check(33)).toBe('at most 32');
    expect(transferJobs_check(2.5)).toBe('not a whole number');
  });
});

describe('transferPool_run', () => {
  it('refuses a number of jobs out of range', async () => {
    await expect(transferPool_run([1], async (n: number): Promise<number> => n, { jobs: 0 })).rejects.toThrow(RangeError);
    await expect(transferPool_run([1], async (n: number): Promise<number> => n, { jobs: 33 })).rejects.toThrow('jobs: 33: at most 32');
  });

  it('never has more than jobs in flight, and keeps that many busy', async () => {
    let inFlight: number = 0;
    let most: number = 0;
    const items: number[] = Array.from({ length: 20 }, (_: unknown, index: number): number => index);
    const result: TransferPoolResult<number, number> = await transferPool_run(items, async (n: number): Promise<number> => {
      inFlight++;
      most = Math.max(most, inFlight);
      await tick(1 + (n % 3));
      inFlight--;
      return n;
    }, { jobs: 4 });
    expect(most).toBe(4);
    expect(result.done).toHaveLength(20);
    expect(result.failed).toEqual([]);
    expect(result.cancelled).toEqual([]);
  });

  it('runs one at a time with jobs 1, in order', async () => {
    const order: number[] = [];
    let inFlight: number = 0;
    let most: number = 0;
    await transferPool_run([1, 2, 3], async (n: number): Promise<void> => {
      inFlight++;
      most = Math.max(most, inFlight);
      order.push(n);
      await tick();
      inFlight--;
    }, { jobs: 1 });
    expect(most).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('starts no more workers than there are items', async () => {
    const result: TransferPoolResult<number, number> = await transferPool_run([7], async (n: number): Promise<number> => n, { jobs: 32 });
    expect(result.done).toEqual([{ item: 7, value: 7 }]);
    expect((await transferPool_run([], async (n: number): Promise<number> => n, { jobs: 8 })).done).toEqual([]);
  });

  it('settles in the order items end, and the totals do not depend on that order', async () => {
    const gates: Gate[] = [gate_make(), gate_make(), gate_make()];
    const sizes: number[] = [10, 20, 30];
    const settled: number[] = [];
    let bytes: number = 0;
    const running: Promise<TransferPoolResult<number, number>> = transferPool_run([0, 1, 2], async (n: number): Promise<number> => {
      await gates[n].promise;
      return sizes[n];
    }, {
      jobs: 3,
      onSettled: (one: TransferSettled<number, number>): void => {
        settled.push(one.item);
        if (one.ok) bytes += one.value;
      },
    });
    gates[2].open();
    await tick();
    gates[0].open();
    await tick();
    gates[1].open();
    const result: TransferPoolResult<number, number> = await running;
    expect(settled).toEqual([2, 0, 1]);
    expect(bytes).toBe(60);
    expect(result.done.map((one: { item: number }): number => one.item)).toEqual([2, 0, 1]);
  });

  it('tries a failed item once more, and a second success counts as done', async () => {
    const tries: Map<string, number> = new Map();
    const settled: TransferSettled<string, string>[] = [];
    const result: TransferPoolResult<string, string> = await transferPool_run(['a', 'flaky'], async (name: string): Promise<string> => {
      const count: number = (tries.get(name) ?? 0) + 1;
      tries.set(name, count);
      if (name === 'flaky' && count === 1) throw new Error('CUBE answered 502');
      return name;
    }, { jobs: 2, onSettled: (one: TransferSettled<string, string>): void => { settled.push(one); } });
    expect(tries.get('flaky')).toBe(2);
    expect(tries.get('a')).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.done).toHaveLength(2);
    expect(settled.find((one: TransferSettled<string, string>): boolean => one.item === 'flaky')).toMatchObject({ ok: true, attempts: 2 });
  });

  it('reports an item that fails twice by name and lets the rest continue', async () => {
    const settled: TransferSettled<string, string>[] = [];
    const result: TransferPoolResult<string, string> = await transferPool_run(['a', 'broken', 'c', 'd'], async (name: string): Promise<string> => {
      if (name === 'broken') throw new Error('no such file');
      await tick();
      return name;
    }, { jobs: 2, onSettled: (one: TransferSettled<string, string>): void => { settled.push(one); } });
    expect(result.failed).toEqual([{ item: 'broken', reason: 'no such file', attempts: 2 }]);
    expect(result.done.map((one: { item: string }): string => one.item).sort()).toEqual(['a', 'c', 'd']);
    expect(settled).toHaveLength(4);
    expect(settled.filter((one: TransferSettled<string, string>): boolean => !one.ok)).toHaveLength(1);
  });

  it('takes a thrown non-Error as its text, and retries as many times as asked', async () => {
    let tries: number = 0;
    const result: TransferPoolResult<number, number> = await transferPool_run([1], async (): Promise<number> => {
      tries++;
      throw 'refused';
    }, { jobs: 1, retries: 0 });
    expect(tries).toBe(1);
    expect(result.failed).toEqual([{ item: 1, reason: 'refused', attempts: 1 }]);
  });

  it('a cancel starts nothing new, retries nothing, and hands the signal to the work in flight', async () => {
    const controller: AbortController = new AbortController();
    const started: number[] = [];
    const sawAbort: number[] = [];
    const items: number[] = Array.from({ length: 10 }, (_: unknown, index: number): number => index);
    const running: Promise<TransferPoolResult<number, number>> = transferPool_run(items, (n: number, signal: AbortSignal): Promise<number> => {
      started.push(n);
      return new Promise<number>((resolve: (value: number) => void, reject: (error: Error) => void): void => {
        if (n === 0) { resolve(n); return; }
        signal.addEventListener('abort', (): void => { sawAbort.push(n); reject(new Error('cancelled')); });
      });
    }, { jobs: 3, signal: controller.signal });
    await tick();
    controller.abort();
    const result: TransferPoolResult<number, number> = await running;
    // Three workers: 0 ended at once, so 1, 2, 3 were in flight; nothing after.
    expect(started).toEqual([0, 1, 2, 3]);
    expect(sawAbort.sort()).toEqual([1, 2, 3]);
    expect(result.done).toEqual([{ item: 0, value: 0 }]);
    expect(result.failed).toEqual([]);
    expect(result.cancelled.sort((a: number, b: number): number => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('starts nothing when the signal has fired already', async () => {
    const controller: AbortController = new AbortController();
    controller.abort();
    let started: number = 0;
    const result: TransferPoolResult<number, number> = await transferPool_run([1, 2], async (n: number): Promise<number> => { started++; return n; }, { jobs: 2, signal: controller.signal });
    expect(started).toBe(0);
    expect(result.cancelled).toEqual([1, 2]);
  });

  it('keeps each attempt\'s notes to itself, and hands the last attempt\'s to the caller', async () => {
    const gates: Gate[] = [gate_make(), gate_make()];
    const drained: string[][] = [[], []];
    const tries: number[] = [0, 0];
    errorStack.stack_push('warning', 'before the pool');
    // Both items mark and push before either drains: on one shared stack,
    // the first drain would take the other's note too.
    const running: Promise<TransferPoolResult<number, void>> = transferPool_run([0, 1], async (n: number): Promise<void> => {
      tries[n]++;
      const mark: number = errorStack.checkpoint_mark();
      errorStack.stack_push('warning', `note of ${n}, try ${tries[n]}`);
      await gates[n].promise;
      drained[n] = errorStack.checkpoint_drain(mark).map((note: { message: string }): string => note.message);
      errorStack.stack_push('warning', `left by ${n}, try ${tries[n]}`);
      if (n === 1 && tries[n] === 1) throw new Error('once');
    }, { jobs: 2 });
    await tick();
    gates[0].open();
    gates[1].open();
    await running;
    expect(drained[0]).toHaveLength(1);
    expect(drained[0][0]).toContain('note of 0, try 1');
    expect(drained[1][0]).toContain('note of 1, try 2');
    const left: string[] = errorStack.stack_getAll().map((note: { message: string }): string => note.message);
    expect(left).toHaveLength(3);
    expect(left[0]).toContain('before the pool');
    expect(left.some((message: string): boolean => message.includes('left by 0, try 1'))).toBe(true);
    expect(left.some((message: string): boolean => message.includes('left by 1, try 2'))).toBe(true);
    expect(left.some((message: string): boolean => message.includes('left by 1, try 1'))).toBe(false);
  });
});
