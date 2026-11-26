/**
 * @jest-environment jsdom
 */
/**
 * @file A transfer row says how far a download has got, in the daemon's
 * own count: waiting on CUBE, bytes of the whole with rate and time left,
 * done, or why not.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { bytes_words, duration_words, transfer_words, transferUrl_build, transfer_watch, type TransferReport } from '../../src/features/files/transfer.js';

describe('transfer words', () => {
  it('reads each phase', () => {
    expect(transfer_words({ phase: 'opening', bytes: 0, elapsedMs: 16_000 }, null)).toBe('WAITING FOR CUBE · 0:16');
    expect(transfer_words({ phase: 'streaming', bytes: 1_000_000_000, size: 4_000_000_000, elapsedMs: 0 }, 50_000_000)).toBe('1.0 GB OF 4.0 GB · 25% · 50.0 MB/S · 1:00 LEFT');
    expect(transfer_words({ phase: 'streaming', bytes: 0, size: 9, elapsedMs: 14_000 }, null)).toBe("WAITING FOR CUBE'S FIRST BYTE · 0:14");
    expect(transfer_words({ phase: 'done', bytes: 3_777_606_216, elapsedMs: 72_000 }, null)).toBe('DONE · 3.8 GB IN 1:12');
    expect(transfer_words({ phase: 'failed', bytes: 0, reason: 'not yours to read', elapsedMs: 0 }, null)).toBe('FAILED · not yours to read');
    expect(bytes_words(999)).toBe('999 B');
    expect(duration_words(3_725_000)).toBe('1:02:05');
  });

  it('asks progress and cancel on the byte route, the token kept and the path dropped', () => {
    const url: URL = new URL(transferUrl_build('vfs?path=%2Fa&token=t0k&download=1', 'progress', 'dl-1'));
    expect(url.pathname.endsWith('/vfs')).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({ progress: 'dl-1', token: 't0k' });
    expect(new URL(transferUrl_build('vfs?token=t0k', 'cancel', 'dl-1')).searchParams.get('cancel')).toBe('dl-1');
  });
});

describe('transfer_watch', () => {
  it('stands a row at once and shows the daemon\'s report', async () => {
    const reports: TransferReport[] = [{ phase: 'opening', bytes: 0, elapsedMs: 4000 }];
    const fetcher = (async (): Promise<Response> => ({ ok: true, json: async () => reports[0] }) as unknown as Response) as typeof fetch;
    const row = transfer_watch('big.dcm', 'vfs?path=%2Fbig.dcm&token=t', 'dl-row01', fetcher);
    expect(document.querySelector('.transfer-stack .transfer-row')).toBe(row.element);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(row.element.querySelector('.transfer-words')?.textContent).toBe('WAITING FOR CUBE · 0:04');
    row.show({ phase: 'done', bytes: 10, size: 10, elapsedMs: 2000 });
    expect(row.element.dataset['phase']).toBe('done');
    expect(row.element.querySelector('.transfer-action')?.textContent).toBe('CLOSE');
    row.stop();
  });
});

describe('a transfer row never freezes', () => {
  it('says it has lost touch when the session stops answering, and a cancel that gets no answer says so', async () => {
    jest.useFakeTimers();
    // A session that never answers: every ask hangs until its deadline aborts it.
    const asked: Array<[string, string]> = [];
    const fetcher = ((url: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      asked.push([init?.method ?? 'GET', new URL(url).search.replace(/&token=.*/, '')]);
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
    const row = transfer_watch('big.dcm', 'vfs?path=%2Fbig.dcm&token=t', 'dl-silent1', fetcher);
    for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(6000);
    expect(row.element.querySelector('.transfer-words')?.textContent).toBe('LOST TOUCH WITH THE SESSION · STILL ASKING');
    (row.element.querySelector('.transfer-action') as HTMLButtonElement).click();
    expect(row.element.querySelector('.transfer-words')?.textContent).toBe('CANCELLING');
    // A stop changes something and is asked by POST; progress is a read.
    expect(asked[asked.length - 1]).toEqual(['POST', '?cancel=dl-silent1']);
    expect(asked.filter(([, what]: [string, string]): boolean => what.startsWith('?progress=')).every(([method]: [string, string]): boolean => method === 'GET')).toBe(true);
    await jest.advanceTimersByTimeAsync(5100);
    expect(row.element.querySelector('.transfer-words')?.textContent).toBe('THE CANCEL GOT NO ANSWER FROM THE SESSION · PRESS CANCEL AGAIN');
    row.stop();
    jest.useRealTimers();
  });
});
