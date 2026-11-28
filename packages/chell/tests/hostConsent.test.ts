/**
 * @file The person's word for what a session asks beyond what a line asked for: what is shown, what an answer
 * means, one question at a time, and what ends with the line or the connection.
 */
import { describe, it, expect } from '@jest/globals';
import { HostConsent, consentAnswer_read, consentQuestion_render, consentText_quote, type ConsentAsk, type ConsentRequest } from '../src/remote/hostConsent.js';
import { TerminalOwner } from '../src/remote/terminalOwner.js';

const asked = (over: Partial<ConsentRequest> = {}): ConsentRequest => ({ lineId: '1', verified: true, kind: 'shell', action: 'run the host command "ls" on this machine', ...over });

/** An asker that answers from a list, recording each question; a question it is not given an answer for waits. */
function asker_make(answers: string[]): { ask: ConsentAsk; questions: string[] } {
  const questions: string[] = [];
  const ask: ConsentAsk = async (question: string, signal: AbortSignal): Promise<string> => {
    questions.push(question);
    const answer: string | undefined = answers.shift();
    if (answer !== undefined) return answer;
    return new Promise<string>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('withdrawn')); }); });
  };
  return { ask, questions };
}

describe('what a question shows', () => {
  it('makes every control, DEL, C1 and format character visible by its code point, and a typed escape spelling reads differently', () => {
    expect(consentText_quote('ls\u001b[2J\u007f\u009b\u202e\u200dx')).toBe('"ls\\u{1b}[2J\\u{7f}\\u{9b}\\u{202e}\\u{200d}x"');
    // A supplementary format character keeps its whole code point; a literal backslash and a quote are escaped.
    expect(consentText_quote('a\u{E0001}b')).toBe('"a\\u{e0001}b"');
    expect(consentText_quote('\\u{1b} "x"')).toBe('"\\\\u{1b} \\"x\\""');
    expect(consentText_quote('\u001b')).not.toBe(consentText_quote('\\u{1b}'));
    const long: string = 'x'.repeat(5000);
    expect(consentQuestion_render(asked({ action: `run the host command "${long}" on this machine` }), 'play a')).toContain(long);
  });

  it('offers every answer for a request of a pending line, and only yes-once for a request that names no line', () => {
    const full: string = consentQuestion_render(asked(), 'play build.sh');
    expect(full).toContain('while running "play build.sh"');
    for (const offer of ['y = yes, this once', 'l = yes, and any further shell request of this line, whatever it runs', 'r = no, and refuse the rest of this line', 'allow all = let this session run anything it asks on this machine until it disconnects']) expect(full).toContain(offer);
    const legacy: string = consentQuestion_render(asked({ lineId: '1', verified: false }), 'play a');
    expect(legacy).toContain('names no line (the session is older than this chell), while running "play a"');
    expect(legacy).not.toContain('l = ');
    expect(legacy).not.toContain('allow all');
  });

  it('reads only y, l, r and allow all, and l, r and allow all only for a pending line', () => {
    expect([' Y ', 'l', 'r', 'allow all', 'ALLOW ALL', 'a', 'yes', '', 'ls'].map((typed: string) => consentAnswer_read(typed, true))).toEqual(['once', 'line', 'refuse-line', 'all', 'all', 'no', 'no', 'no', 'no']);
    expect(['y', 'l', 'allow all'].map((typed: string) => consentAnswer_read(typed, false))).toEqual(['once', 'no', 'no']);
  });
});

describe('HostConsent', () => {
  it('asks where it can; with no one to ask, refuses', async () => {
    const consent: HostConsent = new HostConsent(null, false, new TerminalOwner());
    consent.line_open('1', '!x');
    expect(await consent.request_decide(asked())).toBe(false);
  });

  it('y allows once; l allows the rest of the line\'s requests of that kind, and not another kind, and not the next line', async () => {
    const { ask, questions } = asker_make(['y', 'l', 'n', 'n']);
    const consent: HostConsent = new HostConsent(ask, false, new TerminalOwner());
    consent.line_open('1', 'play build.sh');
    expect(await consent.request_decide(asked())).toBe(true);
    expect(await consent.request_decide(asked())).toBe(true);
    expect(await consent.request_decide(asked({ action: 'run the host command "rm x"' }))).toBe(true);
    expect(questions).toHaveLength(2);
    expect(await consent.request_decide(asked({ kind: 'pipe' }))).toBe(false);
    consent.line_close('1');
    consent.line_open('2', 'play build.sh');
    expect(await consent.request_decide(asked({ lineId: '2' }))).toBe(false);
    expect(questions).toHaveLength(4);
  });

  it('r refuses the rest of the line and its waiting questions; three No answers do the same', async () => {
    const { ask, questions } = asker_make(['r']);
    const consent: HostConsent = new HostConsent(ask, false, new TerminalOwner());
    consent.line_open('1', 'play a');
    const first: Promise<boolean> = consent.request_decide(asked());
    const queued: Promise<boolean> = consent.request_decide(asked({ action: 'run the host command "b"' }));
    expect([await first, await queued]).toEqual([false, false]);
    expect(questions).toHaveLength(1);
    const noes = asker_make(['n', 'no', 'x']);
    const tired: HostConsent = new HostConsent(noes.ask, false, new TerminalOwner());
    tired.line_open('1', 'play a');
    for (let at = 0; at < 3; at++) expect(await tired.request_decide(asked())).toBe(false);
    expect(await tired.request_decide(asked())).toBe(false);
    expect(noes.questions).toHaveLength(3);
  });

  it('asks one question at a time, in order, and the line\'s end withdraws its open and waiting ones', async () => {
    const { ask, questions } = asker_make([]);
    const consent: HostConsent = new HostConsent(ask, false, new TerminalOwner());
    consent.line_open('1', 'play a');
    const first: Promise<boolean> = consent.request_decide(asked({ action: 'first' }));
    const second: Promise<boolean> = consent.request_decide(asked({ action: 'second' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('first');
    expect(consent.question_isOpen()).toBe(true);
    consent.line_close('1');
    expect([await first, await second]).toEqual([false, false]);
    expect(questions).toHaveLength(1);
    expect(consent.question_isOpen()).toBe(false);
  });

  it('allow all lets the connection\'s requests run without asking, until it closes; a request that names no line is still asked', async () => {
    const { ask, questions } = asker_make(['allow all', 'y']);
    const consent: HostConsent = new HostConsent(ask, false, new TerminalOwner());
    consent.line_open('1', 'play a');
    expect(await consent.request_decide(asked())).toBe(true);
    expect(await consent.request_decide(asked({ kind: 'deliver' }))).toBe(true);
    expect(consent.all_isAllowed()).toBe(true);
    expect(await consent.request_decide(asked({ verified: false }))).toBe(true);
    expect(questions).toHaveLength(2);
    consent.all_close();
    expect(consent.all_isAllowed()).toBe(false);
  });

  it('l for a delivery covers its destination and source root only: another place is asked again', async () => {
    const { ask, questions } = asker_make(['l', 'n']);
    const consent: HostConsent = new HostConsent(ask, false, new TerminalOwner());
    consent.line_open('1', 'download $X ./out');
    expect(await consent.request_decide(asked({ kind: 'deliver', scope: './out|/home/me/x' }))).toBe(true);
    expect(await consent.request_decide(asked({ kind: 'deliver', scope: './out|/home/me/x' }))).toBe(true);
    expect(await consent.request_decide(asked({ kind: 'deliver', scope: '~/.ssh|/home/me/x' }))).toBe(false);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain('to the same place, from the same source');
  });

  it('a request from an older daemon is bound to the sole running line: that line\'s end withdraws its question', async () => {
    const { ask, questions } = asker_make([]);
    const consent: HostConsent = new HostConsent(ask, false, new TerminalOwner());
    consent.line_open('0', 'play a');
    const legacy: Promise<boolean> = consent.request_decide(asked({ lineId: '0', verified: false }));
    await new Promise((r) => setTimeout(r, 5));
    expect(questions).toHaveLength(1);
    consent.line_close('0');
    expect(await legacy).toBe(false);
  });

  it('a question is not put while something else holds the terminal', async () => {
    const owner: TerminalOwner = new TerminalOwner();
    const { ask, questions } = asker_make(['y']);
    const consent: HostConsent = new HostConsent(ask, false, owner);
    consent.line_open('1', 'play a');
    const release: () => void = await owner.terminal_take('pty');
    expect(await consent.request_decide(asked())).toBe(false);
    expect(questions).toEqual([]);
    release();
    expect(await consent.request_decide(asked())).toBe(true);
  });

  it('the flag allows a pending line\'s requests without asking, even with no one to ask; never a line that ended', async () => {
    const consent: HostConsent = new HostConsent(null, true, new TerminalOwner());
    consent.line_open('1', 'play a');
    expect(await consent.request_decide(asked())).toBe(true);
    consent.line_close('1');
    expect(await consent.request_decide(asked())).toBe(false);
  });
});
