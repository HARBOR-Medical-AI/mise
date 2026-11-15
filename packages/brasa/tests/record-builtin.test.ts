/**
 * @file Unit tests for recording a session as a manifest.
 *
 * The claims worth pinning: a recording captures what the session ran and
 * nothing about the recording itself; a played manifest's lines are not
 * captured twice; the identifiers that make a recording personal are offered
 * as parameters; and nothing is invented — no expectations appear that the
 * operator did not write.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

/** What was written, by path. */
const written: Map<string, string> = new Map();

cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
}));

jest.unstable_mockModule('@fnndsc/chili/commands/fs/touch.js', () => ({
  files_touch: async (target: string, options: { withContents?: string }): Promise<boolean> => {
    written.set(target, options.withContents ?? '');
    return true;
  },
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/mkdir.js', () => ({ files_mkdir: async (): Promise<boolean> => true }));

jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  path_resolve: async (p: string): Promise<string> => p.replace(/^~/, '/home/chris'),
  storePath_resolve: async (p: string): Promise<string> => p.replace(/^~/, '/home/chris'),
  commandArgs_process: (args: string[]) => ({ _: args }),
}));

const { builtin_record, identifiers_offer, manifest_render } = await import('../src/builtins/res/record.js');
const { recorder_note, recorderMuted_run, recorder_state, recorder_stop } =
  await import('../src/session/recorder.js');

beforeEach(() => {
  written.clear();
  recorder_stop();
  process.exitCode = 0;
});

describe('record', () => {
  it('captures what the session ran, in order', async () => {
    await builtin_record(['start', '~/flows/f.mise']);
    recorder_note('pacs query PatientID:1279049');
    recorder_note('gather add --shown');
    await builtin_record(['stop']);
    const manifest: string = written.get('/home/chris/flows/f.mise') ?? '';
    const lines: string[] = manifest.trimEnd().split('\n');
    expect(lines).toContain('gather add --shown');
    expect(lines.indexOf('pacs query PatientID:${MRN}')).toBeLessThan(lines.indexOf('gather add --shown'));
  });

  it('never films its own camera', async () => {
    await builtin_record(['start', '~/f.mise']);
    recorder_note('record status');
    recorder_note('pwd');
    await builtin_record(['stop']);
    expect(written.get('/home/chris/f.mise')).toContain('pwd');
    expect(written.get('/home/chris/f.mise')).not.toContain('record status');
  });

  it('does not capture the lines a played manifest runs', async () => {
    await builtin_record(['start', '~/f.mise']);
    recorder_note('pwd');
    await recorderMuted_run(async (): Promise<void> => { recorder_note('expect gather size eq 14'); });
    recorder_note('ls');
    await builtin_record(['stop']);
    const manifest: string = written.get('/home/chris/f.mise') ?? '';
    expect(manifest).toContain('pwd');
    expect(manifest).toContain('ls');
    expect(manifest).not.toContain('expect gather size');
  });

  it('invents no expectations: a transcript is not a test until an author says so', async () => {
    await builtin_record(['start', '~/f.mise']);
    recorder_note('gather add /a');
    await builtin_record(['stop']);
    expect(written.get('/home/chris/f.mise')).not.toContain('expect ');
  });

  it('refuses a second recording rather than losing the first', async () => {
    await builtin_record(['start', '~/one.mise']);
    const envelope = await builtin_record(['start', '~/two.mise']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('/home/chris/one.mise');
    expect(recorder_state().target).toBe('/home/chris/one.mise');
  });

  it('writes nothing when the session ran nothing', async () => {
    await builtin_record(['start', '~/f.mise']);
    const envelope = await builtin_record(['stop']);
    expect(envelope.status).toBe('ok');
    expect(written.size).toBe(0);
  });

  it('says nothing is recording when nothing is', async () => {
    expect((await builtin_record(['status'])).rendered).toContain('Nothing is recording');
    expect((await builtin_record(['stop'])).status).toBe('error');
  });
});

describe('identifiers_offer', () => {
  it('offers the identifiers a PACS line wears on its face', () => {
    const { lines, params } = identifiers_offer(['pacs query AccessionNumber:22119730']);
    expect(lines).toEqual(['pacs query AccessionNumber:${ACC}']);
    expect(params).toEqual([{ name: 'ACC', was: '22119730' }]);
  });

  it('gives the same identifier one name wherever it appears', () => {
    const { lines, params } = identifiers_offer([
      'pacs query PatientID:1279049',
      'pull /net/pacs/queries/PatientID:1279049_qid:1',
    ]);
    expect(params).toHaveLength(1);
    expect(lines[1]).toContain('PatientID:${MRN}');
  });

  it('gives a second patient a name of its own', () => {
    const { params } = identifiers_offer([
      'pacs query PatientID:1279049',
      'pacs query PatientID:9999999',
    ]);
    expect(params.map((p) => p.name)).toEqual(['MRN', 'MRN_2']);
  });

  it('leaves alone what it cannot justify parameterizing', () => {
    const { lines, params } = identifiers_offer(['gather add /home/chris/uploads/brain']);
    expect(lines).toEqual(['gather add /home/chris/uploads/brain']);
    expect(params).toEqual([]);
  });
});

describe('manifest_render', () => {
  it('writes the parameters it offered as defaults, so the file still plays as recorded', () => {
    const text: string = manifest_render('sag cohort', ['pacs query PatientID:${MRN}'], [{ name: 'MRN', was: '1279049' }]);
    expect(text).toContain('@name         sag cohort');
    expect(text).toContain('@param        MRN = 1279049');
  });
});
