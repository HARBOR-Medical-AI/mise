/**
 * Tests for ui (readline prompt).
 */
jest.mock('readline');

import readline from 'readline';
import { prompt_confirm } from '../src/utils/ui';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('prompt_confirm', () => {
  it.each([
    ['y', true],
    ['n', false],
    ['', false],
  ])('answer %s -> %s', async (answer, expected) => {
    (readline.createInterface as jest.Mock).mockReturnValue({
      question: (_q: string, cb: (a: string) => void) => cb(answer),
      close: jest.fn(),
    });
    expect(await prompt_confirm('OK?')).toBe(expected);
  });
});
