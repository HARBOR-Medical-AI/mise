/**
 * Tests for the `pacs status` builtin: target resolution (query id, VFS path,
 * expression with existing-query reuse and fresh-query fallback) and report
 * rendering (fill bars, states, in-CUBE folder paths, summary). Cumin's query
 * listing and status report are stubbed at the module seam.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockQueriesList = jest.fn();
const mockStatusForQuery = jest.fn();
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) =>
    model === undefined ? { status: 'ok', rendered } : { status: 'ok', rendered, model },
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) =>
    renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered },
  pacsQueries_list: mockQueriesList,
  pacsRetrieve_statusForQuery: mockStatusForQuery,
}));

const mockCreateAndWait = jest.fn();
jest.unstable_mockModule('../src/builtins/net/query.js', () => ({
  pacsQuery_createAndWait: mockCreateAndWait,
  queryExpr_parse: (s: string): Record<string, string> | null => {
    const idx: number = s.indexOf(':');
    if (idx < 1) return null;
    return { [s.slice(0, idx)]: s.slice(idx + 1) };
  },
}));

const mockServerResolve = jest.fn();
jest.unstable_mockModule('../src/builtins/net/pacsUtils.js', () => ({
  pacsServer_resolve: mockServerResolve,
}));

jest.unstable_mockModule('../src/lib/spinner.js', () => ({
  spinner: { start: jest.fn(), stop: jest.fn(), updateMessage: jest.fn() },
}));


const { pacsStatus_run } = await import('../src/builtins/net/status.js');

/** A two-series report: one landed, one absent. */
const report = {
  queryId: 2833,
  studies: [
    {
      studyInfo: {},
      studyDescription: 'MR-Brain w/o Contrast',
      series: [
        {
          seriesInfo: {},
          seriesInstanceUID: '1.2.3',
          seriesDescription: 'AAHScout',
          expectedFiles: 128,
          actualFiles: 128,
          status: 'pulled',
          folderPath: '/SERVICES/PACS/PACSDCM/study/00001-AAHScout',
        },
        {
          seriesInfo: {},
          seriesInstanceUID: '4.5.6',
          seriesDescription: 'AX T2',
          expectedFiles: 64,
          actualFiles: 0,
          status: 'pending',
          folderPath: null,
        },
      ],
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockServerResolve.mockResolvedValue('PACSDCM');
  mockStatusForQuery.mockResolvedValue({ ok: true, value: report });
  mockQueriesList.mockResolvedValue({ ok: false });
  mockCreateAndWait.mockResolvedValue(null);
});

describe('pacs status target resolution', () => {
  it('requires an available PACS server', async () => {
    mockServerResolve.mockResolvedValue(null);
    const env = await pacsStatus_run('2833');
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('No PACS server available');
  });

  it('accepts a bare numeric query id', async () => {
    const env = await pacsStatus_run('2833');
    expect(env.status).toBe('ok');
    expect(mockStatusForQuery).toHaveBeenCalledWith(2833);
  });

  it('extracts the query id from a /net/pacs path', async () => {
    await pacsStatus_run('/net/pacs/queries/AccessionNumber:22119730_qid:2833');
    expect(mockStatusForQuery).toHaveBeenCalledWith(2833);
  });

  it('rejects a path without a qid marker', async () => {
    const env = await pacsStatus_run('/net/pacs/queries/nonsense');
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('Cannot parse a query id');
  });

  it('rejects a target that is neither id, path, nor expression', async () => {
    const env = await pacsStatus_run('nonsense');
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('Not a query id, PACS path, or query expression');
  });

  it('reuses the most recent existing query matching an expression', async () => {
    mockQueriesList.mockResolvedValue({
      ok: true,
      value: {
        tableData: [
          { id: 100, query: JSON.stringify({ AccessionNumber: '22119730' }) },
          { id: 2833, query: JSON.stringify({ AccessionNumber: '22119730' }) },
          { id: 3000, query: JSON.stringify({ PatientID: '1279049' }) },
          { id: 3001, query: 'not json' },
          { id: 3002 },
        ],
      },
    });
    await pacsStatus_run('AccessionNumber:22119730');
    expect(mockStatusForQuery).toHaveBeenCalledWith(2833);
    expect(mockCreateAndWait).not.toHaveBeenCalled();
  });

  it('runs a fresh query when no existing one matches the expression', async () => {
    mockCreateAndWait.mockResolvedValue({ queryId: 4000, vfsPath: '/net/pacs/queries/x_qid:4000', decoded: { raw: '' } });
    await pacsStatus_run('AccessionNumber:99999999');
    expect(mockCreateAndWait).toHaveBeenCalled();
    expect(mockStatusForQuery).toHaveBeenCalledWith(4000);
  });

  it('errors when the fallback query fails', async () => {
    const env = await pacsStatus_run('AccessionNumber:99999999');
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('Query failed');
  });

  it('errors when the status report cannot be built', async () => {
    mockStatusForQuery.mockResolvedValue({ ok: false });
    const env = await pacsStatus_run('2833');
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('Failed to build status report');
  });
});

describe('pacs status rendering', () => {
  it('renders bars, counts, states, folder paths, and the summary', async () => {
    const env = await pacsStatus_run('2833');
    expect(env.status).toBe('ok');
    expect(env.rendered).toContain('Query 2833');
    expect(env.rendered).toContain('Study: MR-Brain w/o Contrast');
    expect(env.rendered).toContain('AAHScout');
    expect(env.rendered).toContain('▓'.repeat(20));
    expect(env.rendered).toContain('128/128');
    expect(env.rendered).toContain('/SERVICES/PACS/PACSDCM/study/00001-AAHScout');
    expect(env.rendered).toContain('░'.repeat(20));
    expect(env.rendered).toContain('0/64');
    expect(env.rendered).toContain('1/2 series fully in CUBE');
    expect(env.rendered).toContain('Re-run pull');
    expect(env.model).toMatchObject({ kind: 'pacs.status' });
  });

  it('omits the re-pull hint when everything has landed', async () => {
    const complete = {
      queryId: 2833,
      studies: [{
        studyInfo: {},
        studyDescription: 'S',
        series: [{
          seriesInfo: {}, seriesInstanceUID: '1.2.3', seriesDescription: 'A',
          expectedFiles: 2, actualFiles: 2, status: 'pulled', folderPath: '/SERVICES/x',
        }],
      }],
    };
    mockStatusForQuery.mockResolvedValue({ ok: true, value: complete });
    const env = await pacsStatus_run('2833');
    expect(env.rendered).toContain('1/1 series fully in CUBE');
    expect(env.rendered).not.toContain('Re-run pull');
  });
});
