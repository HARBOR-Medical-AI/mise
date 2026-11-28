/**
 * @file A one-shot consent question on real readline: keys that queue while the question is being written do not
 * answer it; an answer typed once it is on the screen does.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';

// The surface's other collaborators are not under test here; only the prompt is.
jest.unstable_mockModule('@fnndsc/brasa', () => ({
  segment_pipeThrough: jest.fn(),
  file_read: jest.fn(),
  privateTemp_write: jest.fn(),
  suffix_safe: jest.fn(),
  wireName_place: jest.fn(),
}));
const { oneShotPrompt_ask, CONSENT_PURPOSE } = await import('../src/core/cliSurface.js');

describe('one-shot consent, armed only once the question is written', () => {
  it('keys that arrive during the question\'s write are no answer; the answer after it is', async () => {
    const input: PassThrough = new PassThrough();
    let typed: boolean = false;
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      if (!typed && String(chunk).includes('Allow? ')) {
        typed = true;
        input.write('y\n');
      }
      return true;
    }) as typeof process.stdout.write);
    const asking: Promise<string> = oneShotPrompt_ask({ message: 'Allow? ', purpose: CONSENT_PURPOSE }, input);
    await new Promise((r) => setTimeout(r, 100));
    const sawWrite: boolean = typed;
    input.write('n\n');
    const answer: string = await asking;
    stdout.mockRestore();
    expect(sawWrite).toBe(true);
    expect(answer).toBe('n');
  });
});
