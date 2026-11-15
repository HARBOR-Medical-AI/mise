/**
 * @file Unit tests for the query fan-out's arithmetic.
 *
 * A PACS will not match a list — `PatientID:4356325\4433255` returns nothing
 * from a real PACS, and the standard only defines list matching for `UI`
 * attributes — so several patients is several C-FINDs. What is pinned here
 * is the reading of what the operator asked for: the multi-value syntax
 * they type, the file they point at, and the refusal that stands between a
 * typo and hundreds of queries against a shared clinical system.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const stackPush = jest.fn();
const stackPop = jest.fn();
cuminMock_install(() => ({
  Ok: (value: unknown) => ({ ok: true, value }),
  Err: () => ({ ok: false }),
  errorStack: { stack_push: stackPush, stack_pop: stackPop },
}));
const fileContent = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({ fileContent_get: fileContent }));
const pathResolve = jest.fn(async (p: string) => `/home/chris/${p.replace(/^~\//, '')}`);
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: pathResolve, storePath_resolve: pathResolve }));

const {
  QUERY_COHORT_MAX,
  QUERY_INLINE_FANOUT_MAX,
  fanout_permit,
  patients_read,
  queryTerms_expand,
  queryTerms_parse,
} = await import('../src/builtins/net/query.fanout.js');

beforeEach((): void => {
  jest.clearAllMocks();
  stackPop.mockReturnValue({ message: 'no such file' });
});

describe('queryTerms_parse', () => {
  it('reads the operator\'s own multi-value syntax as several values of one key', () => {
    expect(queryTerms_parse('PatientID:1234,4532,6654')).toEqual({ PatientID: ['1234', '4532', '6654'] });
  });

  // The existing two-key form must keep meaning exactly what it meant.
  it('still reads two keys as two keys', () => {
    expect(queryTerms_parse('PatientID:1234,StudyDate:20240101'))
      .toEqual({ PatientID: ['1234'], StudyDate: ['20240101'] });
  });

  it('lets a later key be multi-valued too', () => {
    expect(queryTerms_parse('PatientID:1234,Modality:MR,CT'))
      .toEqual({ PatientID: ['1234'], Modality: ['MR', 'CT'] });
  });

  it('tolerates the spaces a typed line collects', () => {
    expect(queryTerms_parse('PatientID: 1234 , 4532')).toEqual({ PatientID: ['1234', '4532'] });
  });

  it('refuses an expression whose first segment names no key', () => {
    expect(queryTerms_parse('1234,4532')).toBeNull();
    expect(queryTerms_parse('PatientID:')).toBeNull();
    expect(queryTerms_parse(':1234')).toBeNull();
    expect(queryTerms_parse('PatientID:1234,,4532')).toBeNull();
  });
});

describe('queryTerms_expand', () => {
  it('turns one multi-valued key into one question per value', () => {
    expect(queryTerms_expand({ PatientID: ['1', '2', '3'] }))
      .toEqual([{ PatientID: '1' }, { PatientID: '2' }, { PatientID: '3' }]);
  });

  it('fans several multi-valued keys over their cross-product', () => {
    expect(queryTerms_expand({ PatientID: ['1', '2'], Modality: ['MR', 'CT'] })).toEqual([
      { PatientID: '1', Modality: 'MR' },
      { PatientID: '1', Modality: 'CT' },
      { PatientID: '2', Modality: 'MR' },
      { PatientID: '2', Modality: 'CT' },
    ]);
  });

  it('leaves a single-valued expression as the one question it is', () => {
    expect(queryTerms_expand({ PatientID: ['1'], StudyDate: ['20240101'] }))
      .toEqual([{ PatientID: '1', StudyDate: '20240101' }]);
  });
});

describe('fanout_permit', () => {
  it('permits a fan-out inside its ceiling', () => {
    expect(fanout_permit(QUERY_INLINE_FANOUT_MAX, QUERY_INLINE_FANOUT_MAX)).toBe(true);
    expect(stackPush).not.toHaveBeenCalled();
  });

  // Silence here would mean hundreds of C-FINDs launched by a typo.
  it('refuses by name, saying how many and what to do instead', () => {
    expect(fanout_permit(840, QUERY_INLINE_FANOUT_MAX)).toBe(false);
    expect(stackPush).toHaveBeenCalledWith('error', expect.stringContaining('840 queries'));
    expect(stackPush).toHaveBeenCalledWith('error', expect.stringContaining('--patients'));
  });

  it('gives a real cohort a far higher ceiling than a typed line', () => {
    expect(QUERY_COHORT_MAX).toBeGreaterThan(QUERY_INLINE_FANOUT_MAX);
    expect(fanout_permit(200, QUERY_COHORT_MAX)).toBe(true);
  });
});

describe('patients_read', () => {
  it('reads a handful of MRNs listed inline', async () => {
    expect(await patients_read('1234,4532, 6654')).toEqual({ ok: true, value: ['1234', '4532', '6654'] });
    expect(fileContent).not.toHaveBeenCalled();
  });

  // The file is in CFS, read through the session's own path — so the flag
  // behaves the same from a terminal, a remote shell and a browser, and a
  // list on somebody's laptop arrives through `upload` rather than through
  // a second ungated door.
  it('reads a cohort file from ChRIS storage, not from the host disk', async () => {
    fileContent.mockResolvedValue({ ok: true, value: '1234\n4532\n' });
    expect(await patients_read('@~/cohorts/ddh.txt')).toEqual({ ok: true, value: ['1234', '4532'] });
    expect(pathResolve).toHaveBeenCalledWith('~/cohorts/ddh.txt');
    expect(fileContent).toHaveBeenCalledWith('/home/chris/cohorts/ddh.txt');
  });

  it('ignores blank lines and # comments, and trims what is left', async () => {
    fileContent.mockResolvedValue({ ok: true, value: '# DDH cohort\n\n 1234 \n#skip\n4532\n\n' });
    expect(await patients_read('@list.txt')).toEqual({ ok: true, value: ['1234', '4532'] });
  });

  it('names the file it could not read', async () => {
    fileContent.mockResolvedValue({ ok: false });
    expect(await patients_read('@missing.txt')).toEqual({ ok: false });
    expect(stackPush).toHaveBeenCalledWith('error', expect.stringContaining('/home/chris/missing.txt'));
  });

  it('refuses a file that lists no patients rather than asking nothing', async () => {
    fileContent.mockResolvedValue({ ok: true, value: '# only comments\n\n' });
    expect(await patients_read('@empty.txt')).toEqual({ ok: false });
    expect(stackPush).toHaveBeenCalledWith('error', expect.stringContaining('lists no patients'));
  });

  it('refuses an empty value, inline or as a bare sigil', async () => {
    expect(await patients_read('')).toEqual({ ok: false });
    expect(await patients_read('@')).toEqual({ ok: false });
  });
});
