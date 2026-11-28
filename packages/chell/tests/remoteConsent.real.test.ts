/**
 * @file A real session asks a real attached chell for host commands, through the engine's own dispatcher (lists, a
 * skipped branch, the next line), and the person's word decides what runs. The session runs in a child process
 * (`support/remoteConsentSession.mjs`, the built calypso on the null backend, private folders, loopback); host
 * commands are recorded, never run.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script: string = fileURLToPath(new URL('./support/remoteConsentSession.mjs', import.meta.url));

/** What a run of the session reported. */
interface SessionReport {
  ran: string[];
  questions: string[];
  error: string | null;
}

/** Runs lines against a real session with the answers given; returns its report. */
function session_run(answers: string[], lines: string[]): SessionReport {
  const run = spawnSync(process.execPath, [script, JSON.stringify(answers), JSON.stringify(lines)], { encoding: 'utf8', timeout: 60_000 });
  return JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as SessionReport;
}

describe('a real session asks for host commands, and the person decides', () => {
  it('a line\'s own ! runs unasked; a list\'s two host steps run under l with one question; a skipped branch asks nothing; the next line asks afresh', () => {
    const report: SessionReport = session_run(['l', 'n'], ['!echo own', 'pwd && !echo first && !echo second', 'cd /nowhere && !echo never', 'pwd && !echo third']);
    expect(report.error).toBeNull();
    expect(report.ran).toEqual(['echo own', 'echo first', 'echo second']);
    const asked: string[] = report.questions;
    // Between the markers: what each line asked.
    expect(asked[0]).toBe('-- after !echo own');
    expect(asked[1]).toContain('run the host command "echo first" on this machine');
    expect(asked[2]).toBe('-- after pwd && !echo first && !echo second');
    expect(asked[3]).toBe('-- after cd /nowhere && !echo never');
    expect(asked[4]).toContain('run the host command "echo third" on this machine');
    expect(asked[5]).toBe('-- after pwd && !echo third');
  }, 90_000);
});
