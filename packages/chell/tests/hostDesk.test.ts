/**
 * @file The host desk on its own: what `l` for a delivery covers, a program that ends before it is handed the
 * terminal, the terminal passing straight to the next in line, and request ids remembered by digest.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { deliveryIntent_matches, deliverySource_matches } = await import('../../brasa/dist/builtins/fs/deliveryMatch.js');
const { wireName_place } = await import('../../fond/dist/hostPlace.js');
jest.unstable_mockModule('@fnndsc/brasa', () => ({ deliveryIntent_matches, deliverySource_matches, wireName_place }));
const { HostDesk } = await import('../src/remote/hostDesk.js');
const { HostConsent } = await import('../src/remote/hostConsent.js');
const { TerminalOwner } = await import('../src/remote/terminalOwner.js');

/** A desk with a question double that answers from a list (a question with no answer waits until withdrawn). */
function desk_make(answers: string[], hostPty: { start: (id: string) => void; exit: (id: string) => void } | null = null) {
  const questions: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const written: string[] = [];
  const owner = new TerminalOwner();
  let answer_give: ((typed: string) => void) | null = null;
  const consent = new HostConsent(async (question: string, signal: AbortSignal): Promise<string> => {
    questions.push(question);
    const given: string | undefined = answers.shift();
    if (given !== undefined) return given;
    return new Promise<string>((resolve, reject) => {
      answer_give = resolve;
      signal.addEventListener('abort', () => { reject(new Error('withdrawn')); });
    });
  }, false, owner);
  const desk = new HostDesk({
    message_send: (message: Record<string, unknown>): void => { sent.push(message); },
    consent,
    hostPty: hostPty as never,
    owner,
    connection_fail: (): void => undefined,
    notice_show: (): void => undefined,
    shellCommand_run: async (): Promise<number> => 0,
    file_deliver: async (request) => { written.push(request.path); return { location: request.filename, bytes: 1 }; },
  });
  return { desk, questions, sent, written, owner, answer: (typed: string): void => { answer_give?.(typed); } };
}

const NOTHING = { shells: [], pipes: [], edits: [] };

describe('l for a delivery', () => {
  it('covers a sibling from inside the same source into the same folder; a file outside the source it names, or with no source, is offered once only', async () => {
    const out: string = mkdtempSync(join(tmpdir(), 'desk-out-'));
    const { desk, questions, sent, written } = desk_make(['l', 'l', 'y']);
    desk.line_open('1', 'play fetch.sh', NOTHING, []);
    await desk.deliver_run('d1', '1', { path: '/home/u/X/a.txt', filename: 'a.txt', destination: out, source: '/home/u/X' });
    await desk.deliver_run('d2', '1', { path: '/home/u/X/b.txt', filename: 'b.txt', destination: out, source: '/home/u/X' });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('to the same folder here, from inside the same source');
    // The same labels, a file that is not inside the source: asked, `l` not offered, and `l` typed is a No.
    await desk.deliver_run('d3', '1', { path: '/secret/vault.key', filename: 'vault.key', destination: out, source: '/home/u/X' });
    expect(questions).toHaveLength(2);
    expect(questions[1]).toContain('which it is not inside');
    expect(questions[1]).not.toContain('l = yes');
    // No source named: once only.
    await desk.deliver_run('d4', '1', { path: '/home/u/X/c.txt', filename: 'c.txt', destination: out });
    expect(questions).toHaveLength(3);
    expect(questions[2]).not.toContain('l = yes');
    expect(written).toEqual(['/home/u/X/a.txt', '/home/u/X/b.txt', '/home/u/X/c.txt']);
    expect(sent.filter((one) => one.type === 'deliverError').map((one) => one.deliverId)).toEqual(['d3']);
  });
});

describe('a program handed the terminal', () => {
  it('is never handed it when it ended while its hand-over waited for an answer', async () => {
    const started: string[] = [];
    const { desk, questions, sent, owner, answer } = desk_make([], { start: (id: string) => { started.push(id); }, exit: () => undefined });
    desk.line_open('1', 'play a', NOTHING, []);
    const handing: Promise<void> = desk.hostPty_start('p1', '1', 'nvim x');
    await new Promise((r) => setTimeout(r, 5));
    expect(questions).toHaveLength(1);
    desk.pty_end('p1');
    answer('y');
    await handing;
    expect(started).toEqual([]);
    expect(sent.find((one) => one.type === 'hostPtyRefuse')?.reason).toContain('ended before it was handed the terminal');
    expect(owner.holder_get()).toBeNull();
  });
});

describe('the terminal', () => {
  it('passes straight to the next in line: no one takes it between; a withdrawn wait holds nothing', async () => {
    const owner = new TerminalOwner();
    const first = await owner.terminal_take('shell');
    const second: Promise<() => void> = owner.terminal_take('edit');
    const gone = new AbortController();
    const third: Promise<() => void> = owner.terminal_take('prompt', gone.signal);
    first();
    expect(owner.holder_get()).toBe('edit');
    expect(owner.terminal_tryTake('question')).toBeNull();
    gone.abort();
    await expect(third).rejects.toThrow('withdrawn');
    (await second)();
    expect(owner.holder_get()).toBeNull();
  });
});

describe('request ids', () => {
  it('a long id is remembered by digest, refused when sent again, and still refused after the lines retire', async () => {
    const { desk, sent } = desk_make([]);
    const id: string = 'x'.repeat(100_000);
    desk.line_open('1', '!ls', { shells: ['ls'], pipes: [], edits: [] }, []);
    await desk.shell_run(id, 'ls', '1');
    desk.line_retire();
    await desk.shell_run(id, 'ls', '1');
    expect(sent.filter((one) => one.type === 'shellError').map((one) => String(one.reason))).toEqual([expect.stringContaining('again')]);
  });
});
