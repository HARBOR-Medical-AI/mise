/**
 * @file Unit tests for a PACS answer rendered as CSV.
 *
 * The two claims worth pinning are the ones a naive renderer gets wrong: a
 * study description carrying a comma or a quote must survive the trip into
 * a spreadsheet, and a patient with NO studies must still appear — the
 * MRNs that come back are the ones with imaging, so a table built from
 * studies alone drops exactly the rows an audit is asking about.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import { pacsAnswer_renderCsv, pacsAnswer_renderTable } from '../src/builtins/net/query.csv.js';

/** One study, with the fields the table reads. */
function study_make(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: 'Brain MRI',
    patientName: 'DOE^JANE',
    patientId: '1234',
    date: '20240101',
    modalities: 'MR',
    accession: 'A100',
    series: [{ seriesUID: 's1', description: 'T1', modality: 'MR' }],
    ...extra,
  };
}

/** A model with the given studies and patients. */
function model_make(extra: Record<string, unknown> = {}): never {
  return {
    queryId: 1, vfsPath: '/net/pacs/queries/x', pacsName: 'PACSDCM',
    expression: 'PatientID:1234', studies: [], ...extra,
  } as never;
}

/** The CSV split into rows of cells, quotes stripped. */
function rows_of(csv: string): string[][] {
  return csv.trimEnd().split('\n').map((line: string): string[] =>
    line.split('","').map((cell: string): string => cell.replace(/^"|"$/g, '')));
}

describe('pacsAnswer_renderCsv', () => {
  it('heads the table with the columns the listing shows', () => {
    const [header] = rows_of(pacsAnswer_renderCsv(model_make()));
    expect(header).toEqual([
      'MRN', 'PATIENT', 'SERVER', 'STATUS', 'STUDY', 'DATE',
      'ACCESSION', 'MODALITY', 'SERIES', 'ANSWERED',
    ]);
  });

  it('renders a study per row, naming the server that answered', () => {
    const csv: string = pacsAnswer_renderCsv(model_make({ studies: [study_make()] }));
    const [, row] = rows_of(csv);
    expect(row).toEqual(['1234', 'DOE^JANE', 'PACSDCM', 'found', 'Brain MRI', '20240101',
      'A100', 'MR', '1', '']);
  });

  // The row that cannot be derived from studies, and the one an audit is
  // usually about.
  it('gives a patient with no imaging a row of its own', () => {
    const csv: string = pacsAnswer_renderCsv(model_make({
      patients: [{ patientId: '9999', status: 'none', studyCount: 0, seriesCount: 0 }],
    }));
    const [, row] = rows_of(csv);
    expect(row[0]).toBe('9999');
    expect(row[3]).toBe('none');
    expect(row[8]).toBe('0');
  });

  it('distinguishes a patient nothing could be asked about', () => {
    const csv: string = pacsAnswer_renderCsv(model_make({
      patients: [{ patientId: '9999', status: 'unasked', studyCount: 0, seriesCount: 0 }],
    }));
    expect(rows_of(csv)[1][3]).toBe('unasked');
  });

  it('carries each row\'s own answer time as a timestamp a spreadsheet can sort', () => {
    const csv: string = pacsAnswer_renderCsv(model_make({
      studies: [study_make()],
      patients: [{
        patientId: '1234', status: 'found', studyCount: 1, seriesCount: 1,
        provenance: { replayed: true, answeredAt: '2026-06-14T09:22:00.000Z' },
      }],
    }));
    expect(rows_of(csv)[1][9]).toBe('2026-06-14T09:22:00.000Z');
  });

  // Where a naive renderer breaks: a study description is free text.
  it('survives a comma and a quote in a study description', () => {
    const csv: string = pacsAnswer_renderCsv(model_make({
      studies: [study_make({ description: 'MRI BRAIN, W/ AND W/O "GAD"' })],
    }));
    const line: string = csv.trimEnd().split('\n')[1];
    expect(line).toContain('"MRI BRAIN, W/ AND W/O ""GAD"""');
    // Ten columns, whatever the text inside them.
    expect(line.split('","')).toHaveLength(10);
  });

  it('keeps a cohort\'s rows in the order the patients were asked', () => {
    const csv: string = pacsAnswer_renderCsv(model_make({
      studies: [study_make({ patientId: '2' })],
      patients: [
        { patientId: '1', status: 'none', studyCount: 0, seriesCount: 0 },
        { patientId: '2', status: 'found', studyCount: 1, seriesCount: 1 },
        { patientId: '3', status: 'unasked', studyCount: 0, seriesCount: 0 },
      ],
    }));
    expect(rows_of(csv).slice(1).map((row: string[]): string => row[0])).toEqual(['1', '2', '3']);
  });

  it('renders an answer that found nothing as a header and no rows', () => {
    expect(rows_of(pacsAnswer_renderCsv(model_make()))).toHaveLength(1);
  });
});

describe('an answer at series level', () => {
  const twoSeries = (): never => model_make({
    studies: [study_make({ series: [
      { seriesUID: 's1', description: 'T1, sagittal', modality: 'MR', fileCount: 176, pulled: true },
      { seriesUID: 's2', description: 'DWI', modality: 'MR', fileCount: 30, pulled: false },
    ] })],
  });

  it('gives each series a row carrying its study, under names that cannot be read as the study\'s', () => {
    const rows: string[][] = rows_of(pacsAnswer_renderCsv(twoSeries(), 'series'));
    expect(rows[0]).toEqual(['MRN', 'PATIENT', 'SERVER', 'STATUS', 'STUDY', 'DATE', 'ACCESSION', 'SERIES#', 'SERIES DESCRIPTION', 'MODALITY', 'FILES', 'PULLED', 'ANSWERED']);
    expect(rows.length).toBe(3);
    expect(rows[1]?.slice(4, 12)).toEqual(['Brain MRI', '20240101', 'A100', '1', 'T1, sagittal', 'MR', '176', 'yes']);
    expect(rows[2]?.slice(7, 12)).toEqual(['2', 'DWI', 'MR', '30', 'no']);
  });

  it('keeps a study with no series as a row, and a patient with no studies', () => {
    const csv: string = pacsAnswer_renderCsv(model_make({
      studies: [study_make({ series: [] })],
      patients: [
        { patientId: '1234', status: 'found', studyCount: 1, seriesCount: 0 },
        { patientId: '9999', status: 'none', studyCount: 0, seriesCount: 0 },
      ],
    }), 'series');
    const rows: string[][] = rows_of(csv);
    expect(rows.length).toBe(3);
    expect(rows[1]?.[4]).toBe('Brain MRI');
    expect(rows[1]?.[7]).toBe('');
    expect(rows[2]?.[0]).toBe('9999');
    expect(rows[2]?.[3]).toBe('none');
  });
});

describe('pacsAnswer_renderTable', () => {
  it('aligns the CSV\'s columns without ANSWERED, cuts nothing, and says what a row is', () => {
    const long: string = 'A study description far longer than any column would ever want to be';
    const table: string = pacsAnswer_renderTable(model_make({ studies: [study_make({ description: long })], provenance: { replayed: false, answeredAt: '2026-09-10T14:48:39Z' } }));
    const lines: string[] = table.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^  MRN +PATIENT +SERVER +STATUS +STUDY +DATE +ACCESSION +MODALITY +SERIES$/);
    expect(table).not.toContain('ANSWERED');
    expect(table).not.toContain('2026-09-10');
    expect(table).toContain(long);
    // Every column starts where its header does.
    expect(lines[2]?.indexOf('20240101')).toBe(lines[0]?.indexOf('DATE'));
    expect(lines[lines.length - 1]).toBe('  1 row, one per study');
  });

  it('renders at series level when asked', () => {
    const table: string = pacsAnswer_renderTable(model_make({ studies: [study_make()] }), 'series');
    expect(table.split('\n')[0]).toContain('SERIES DESCRIPTION');
    expect(table).toContain('1 row, one per series');
  });
});

describe('csvFile_write', () => {
  /** The salsa and path seams a write reaches for. */
  const listAll = jest.fn<(...args: unknown[]) => Promise<{ tableData: Array<{ fname: string }> } | null>>();
  const invalidate = jest.fn();
  const create = jest.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
  const mkdir = jest.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
  const isDirectory = jest.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
  const remove = jest.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);

  beforeEach((): void => {
    jest.clearAllMocks();
    listAll.mockResolvedValue({ tableData: [] });
    isDirectory.mockResolvedValue(true);
    create.mockResolvedValue(true);
    mkdir.mockResolvedValue(true);
    // The write invalidates the folder's cached listing, so the cache is
    // part of the seam now: a table CUBE holds that `ls` cannot see is the
    // defect this covers.
    cuminMock_install(() => ({
      errorStack: { stack_pop: jest.fn() },
      listCache_get: (): { cache_invalidate: (path: string) => void } => ({ cache_invalidate: invalidate }),
    }));
    jest.unstable_mockModule('../src/builtins/utils.js', () => ({
      storePath_resolve: async (p: string): Promise<string> => p.replace('~', '/home/chris'),
      error_stripDebugPrefix: (m: string): string => m,
    }));
    jest.unstable_mockModule('@fnndsc/salsa', () => ({
      files_create: create, files_listAll: listAll, files_mkdir: mkdir,
      files_path_isDirectory: isDirectory, files_delete: remove,
    }));
  });

  /** The module under test, freshly wired to the mocks above. */
  async function write_load(): Promise<typeof import('../src/builtins/net/query.csv.js')['csvFile_write']> {
    const module = await import('../src/builtins/net/query.csv.js');
    return module.csvFile_write;
  }

  // A provider is somewhere to browse, not somewhere a file lands. CUBE's
  // own refusal talks about an upload, which says nothing about why.
  it('refuses a provider path by name, before writing anything', async () => {
    const write = await write_load();
    for (const where of ['/net/pacs/x.csv', '/bin/x.csv', '/proc/jobs/x.csv', '/usr/x.csv', '/etc/x.csv']) {
      const result = await write('csv', where);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('provider');
    }
    expect(create).not.toHaveBeenCalled();
  });

  // An audit table quietly replacing another audit table is the silent
  // workaround the principles forbid.
  it('keeps an existing file unless the operator says it twice', async () => {
    listAll.mockResolvedValue({ tableData: [{ fname: '/home/chris/audits/a.csv', id: 7 }] });
    const write = await write_load();
    const refused = await write('csv', '~/audits/a.csv');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('--force');
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  // CUBE answers a re-upload over a path it already holds with a 500, so
  // "overwrite" is spelled out: the file that was there is removed first,
  // and the removal is reported.
  it('replaces by removing first, and says that it did', async () => {
    // The store answers: it is there (the overwrite check), then it is
    // gone (the removal, which CUBE performs asynchronously), then the new
    // one is there (the confirmation after writing).
    listAll
      .mockResolvedValueOnce({ tableData: [{ fname: '/home/chris/audits/a.csv', id: 7 }] })
      .mockResolvedValueOnce({ tableData: [] })
      .mockResolvedValue({ tableData: [{ fname: '/home/chris/audits/a.csv', id: 9 }] });
    const write = await write_load();
    const forced = await write('csv', '~/audits/a.csv', true);
    expect(remove).toHaveBeenCalledWith(7, 'files', '/home/chris/audits');
    expect(create).toHaveBeenCalledTimes(1);
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.replaced).toBe(true);
  });

  it('refuses when what is there cannot be removed', async () => {
    listAll.mockResolvedValue({ tableData: [{ fname: '/home/chris/audits/a.csv', id: 7 }] });
    remove.mockResolvedValue(false);
    const write = await write_load();
    const result = await write('csv', '~/audits/a.csv', true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('could not be replaced');
    expect(create).not.toHaveBeenCalled();
  });

  // A throw out of a builtin does not stop at the command: under a daemon
  // it takes the process, and every surface attached to it.
  it('turns a store\'s bad day into a refusal, not an outage', async () => {
    create.mockRejectedValue(new Error('Request failed with status code 500'));
    const write = await write_load();
    const result = await write('csv', '~/audits/boom.csv');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('500');
  });

  it('makes a missing folder, and says which one it made', async () => {
    isDirectory.mockResolvedValue(false);
    listAll.mockResolvedValue({ tableData: [{ fname: '/home/chris/audits/a.csv' }] });
    const write = await write_load();
    const result = await write('csv', '~/audits/a.csv');
    expect(mkdir).toHaveBeenCalledWith('/home/chris/audits');
    expect(result.ok).toBe(true);
    // Both listings the write made wrong: the folder it wrote into, and the
    // one that would show the folder it had to make.
    expect(invalidate).toHaveBeenCalledWith('/home/chris/audits');
    expect(invalidate).toHaveBeenCalledWith('/home/chris');
    if (result.ok) expect(result.created).toBe('/home/chris/audits');
  });

  it('refuses by name when the folder cannot be made', async () => {
    isDirectory.mockResolvedValue(false);
    mkdir.mockResolvedValue(false);
    const write = await write_load();
    const result = await write('csv', '~/nowhere/a.csv');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('could not be created');
    expect(create).not.toHaveBeenCalled();
  });


  // `files_listAll` answers null for an empty folder AND for one that is
  // not there, so existence is never inferred from it: doing so reported a
  // folder "made" that already existed, and a file "already there" in a
  // folder that did not exist at all.
  it('reads an empty folder as empty, not as missing', async () => {
    isDirectory.mockResolvedValue(true);
    listAll.mockResolvedValueOnce(null).mockResolvedValue({ tableData: [{ fname: '/home/chris/audits/a.csv' }] });
    const write = await write_load();
    const result = await write('csv', '~/audits/a.csv');
    expect(mkdir).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBeUndefined();
  });

  // A create straight after making its folder has been seen to report
  // success and leave nothing behind. A table an operator believes they
  // have is worse than one they know they lack.
  it('refuses to claim a write it cannot find afterwards', async () => {
    isDirectory.mockResolvedValue(true);
    listAll.mockResolvedValue({ tableData: [] });
    const write = await write_load();
    const result = await write('csv', '~/audits/ghost.csv');
    expect(create).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('is not there');
  });

  it('answers with the path it actually wrote, resolved', async () => {
    listAll.mockResolvedValueOnce({ tableData: [] })
      .mockResolvedValue({ tableData: [{ fname: '/home/chris/audits/a.csv' }] });
    const write = await write_load();
    const result = await write('csv', '~/audits/a.csv');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe('/home/chris/audits/a.csv');
      expect(result.created).toBeUndefined();
    }
  });
});
