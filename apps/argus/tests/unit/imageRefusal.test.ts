/**
 * @jest-environment jsdom
 */
/**
 * @file A refused slice asks the byte route why and reads the answer out.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { refusal_explain } from '../../src/features/image/refusal.js';

/** A body read in the given chunks, breaking after them when `breaks` is set. */
const body_of = (chunks: string[], breaks: boolean): { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } => ({
  getReader: () => {
    const left: Uint8Array[] = chunks.map((chunk: string) => new Uint8Array(chunk.length));
    return {
      read: async () => {
        const next: Uint8Array | undefined = left.shift();
        if (next !== undefined) return { done: false, value: next };
        if (breaks) throw new TypeError('network error');
        return { done: true };
      },
    };
  },
});

const answer = (status: number, text: string, extra: { length?: number; chunks?: string[]; breaks?: boolean } = {}): void => {
  (globalThis as { fetch: unknown }).fetch = async (): Promise<unknown> => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string): string | null => (name === 'content-length' && extra.length !== undefined ? String(extra.length) : null) },
    body: body_of(extra.chunks ?? [text], extra.breaks ?? false),
    text: async (): Promise<string> => text,
  });
};

describe('refusal_explain', () => {
  const original: unknown = (globalThis as { fetch: unknown }).fetch;
  afterEach((): void => { (globalThis as { fetch: unknown }).fetch = original; });

  it('reads the route\'s line in capitals with its status, from a wadouri id with a frame', async () => {
    answer(403, 'not yours to read: CUBE refused the bytes (403)\n');
    expect(await refusal_explain('wadouri:http://h/vfs?path=%2Fa&token=t&frame=3')).toBe('NOT YOURS TO READ: CUBE REFUSED THE BYTES (403)');
  });

  it('says what a 404 and a 502 said', async () => {
    answer(404, 'no such file in CUBE (404)');
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('NO SUCH FILE IN CUBE (404)');
    answer(502, 'CUBE could not serve it (500)');
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('CUBE COULD NOT SERVE IT (500) (502)');
  });

  it('says the porter\'s words, never its JSON', async () => {
    answer(502, '{"error":"the session closed the connection before it answered (other side closed)"}');
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('THE SESSION CLOSED THE CONNECTION BEFORE IT ANSWERED (OTHER SIDE CLOSED) (502)');
    answer(502, '{"error":"the session did not answer: connect ECONNREFUSED 127.0.0.1:4444"}');
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('THE SESSION DID NOT ANSWER: CONNECT ECONNREFUSED 127.0.0.1:4444 (502)');
    answer(502, 'the file did not arrive from CUBE: socket hang up');
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('THE FILE DID NOT ARRIVE FROM CUBE: SOCKET HANG UP (502)');
  });

  it('a 200 whose body stops part way is a file that stopped arriving, with how much came', async () => {
    answer(200, '', { length: 3_000_000, chunks: ['x'.repeat(1_200_000)], breaks: true });
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('THE FILE STOPPED ARRIVING PART WAY (1.2 MB OF 3.0 MB)');
    answer(200, '', { chunks: ['x'.repeat(2_000)], breaks: true });
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('THE FILE STOPPED ARRIVING PART WAY (AFTER 2.0 KB)');
    answer(200, '', { length: 10, chunks: ['abc'] });
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('THE FILE STOPPED ARRIVING PART WAY (3 B OF 10 B)');
  });

  it('names an undecodable file when the whole file came, and a route that does not answer', async () => {
    answer(200, 'bytes', { length: 5 });
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('COULD NOT BE DECODED');
    (globalThis as { fetch: unknown }).fetch = async (): Promise<unknown> => { throw new Error('down'); };
    expect(await refusal_explain('http://h/vfs?path=%2Fa')).toBe('COULD NOT BE READ');
  });
});
