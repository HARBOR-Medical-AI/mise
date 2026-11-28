/**
 * @file A one-shot chell's consent question on a real pseudo-terminal: a line typed before the question, or half of
 * one, never answers it; only what is typed after it does. Runs the built chell (`support/consentTty.mjs`).
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script: string = fileURLToPath(new URL('./support/consentTty.mjs', import.meta.url));

/** What a run reported: the answer read, or why the question failed, how soon, and whether raw mode was left on. */
interface TtyReport {
  answer?: string | null;
  failed?: { reason: string; ms: number; raw: boolean };
}

/** Runs the question on a pseudo-terminal in a mode; see `support/consentTty.mjs`. */
function tty_run(ahead: string, mode: string = 'answer'): TtyReport {
  const run = spawnSync(process.execPath, [script, JSON.stringify(ahead), mode], { encoding: 'utf8', timeout: 20_000 });
  return JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as TtyReport;
}

/** Types `ahead` before the question and `n` after it; returns what the question read. */
function answer_read(ahead: string): string | null | undefined {
  return tty_run(ahead).answer;
}

describe('a one-shot consent question on a terminal', () => {
  it('a whole line typed before it does not answer it', () => {
    expect(answer_read('y\r')).toBe('n');
  }, 30_000);

  it('half a line typed before it is not the start of its answer', () => {
    expect(answer_read('y')).toBe('n');
  }, 30_000);

  it('withdrawn while what was typed is being dropped, it fails at once and leaves the terminal as it was', () => {
    const report: TtyReport = tty_run('y', 'withdraw');
    expect(report.failed?.reason).toBe('the question was withdrawn');
    expect(report.failed?.ms).toBeLessThan(800);
    expect(report.failed?.raw).toBe(false);
  }, 30_000);

  it('a terminal still being typed into after a second is refused, not asked', () => {
    const report: TtyReport = tty_run('', 'noisy');
    expect(report.failed?.reason).toContain('still being typed into');
    expect(report.failed?.raw).toBe(false);
  }, 30_000);
});

const replScript: string = fileURLToPath(new URL('./support/consentReplTty.mjs', import.meta.url));

/** Types `ahead` during a stall of the REPL's loop, before its consent question is drawn; returns what it read. */
function replAnswer_read(ahead: string, when: string = 'before'): string | null | undefined {
  const run = spawnSync(process.execPath, [replScript, JSON.stringify(ahead), '550', '800', when], { encoding: 'utf8', timeout: 20_000 });
  return (JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as TtyReport).answer;
}

describe('a consent question in the REPL, on a terminal, after the loop stalled', () => {
  it('a "y" typed during the stall, before the question is drawn, does not answer it', () => {
    expect(replAnswer_read('y\r')).toBe('n');
  }, 30_000);

  it('"allow all" typed during the stall does not answer it', () => {
    expect(replAnswer_read('allow all\r')).toBe('n');
  }, 30_000);

  it('a "y" typed while the loop stalls during the wait for quiet (not before it) does not answer it', () => {
    expect(replAnswer_read('y\r', 'during')).toBe('n');
  }, 30_000);
});
