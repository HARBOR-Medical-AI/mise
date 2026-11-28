/**
 * @file A one-shot chell's consent question on a real pseudo-terminal: a line typed before the question, or half of
 * one, never answers it; only what is typed after it does. Runs the built chell (`support/consentTty.mjs`).
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script: string = fileURLToPath(new URL('./support/consentTty.mjs', import.meta.url));

/** Types `ahead` before the question and `n` after it; returns what the question read. */
function answer_read(ahead: string): string | null {
  const run = spawnSync(process.execPath, [script, JSON.stringify(ahead)], { encoding: 'utf8', timeout: 20_000 });
  return (JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as { answer: string | null }).answer;
}

describe('a one-shot consent question on a terminal', () => {
  it('a whole line typed before it does not answer it', () => {
    expect(answer_read('y\r')).toBe('n');
  }, 30_000);

  it('half a line typed before it is not the start of its answer', () => {
    expect(answer_read('y')).toBe('n');
  }, 30_000);
});
