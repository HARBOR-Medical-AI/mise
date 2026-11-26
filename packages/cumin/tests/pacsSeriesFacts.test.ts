/**
 * @file What CUBE's series record says of a series in its PACS store.
 *
 * CUBE cannot be asked by folder, so a series' facts are found through its
 * patient: the patient folder begins with the patient's ID, the series list
 * answers by patient, and the folder is matched exactly among the answer.
 * One ask serves every series of the patient; a failed ask is not kept.
 */

jest.mock('../src/connect/chrisConnection', () => ({
  chrisConnection: { client_get: jest.fn() },
}));

import { chrisConnection } from '../src/connect/chrisConnection';
import { pacsSeriesFolder_parse, pacsSeriesFacts_fetch, pacsSeriesFacts_clear } from '../src/pacs/chrisPACS';

const mockClientGet: jest.Mock = chrisConnection.client_get as unknown as jest.Mock;
const list_of = (rows: unknown[]): unknown => ({ getItems: (): unknown[] => rows, totalCount: rows.length });
const FOLDER: string = 'SERVICES/PACS/PACSDCM/1234567-X-19000101/Study-1-20200101/00005-SAG_MPRAGE-abc';

beforeEach(() => {
  jest.clearAllMocks();
  pacsSeriesFacts_clear();
});

describe('pacsSeriesFolder_parse', () => {
  it('finds the series folder, PACS and patient of a path in the PACS store, and nothing elsewhere', () => {
    expect(pacsSeriesFolder_parse(`/${FOLDER}/0001.dcm`)).toEqual({ folder: FOLDER, pacs: 'PACSDCM', patient: '1234567-X-19000101' });
    expect(pacsSeriesFolder_parse(FOLDER)).toEqual({ folder: FOLDER, pacs: 'PACSDCM', patient: '1234567-X-19000101' });
    expect(pacsSeriesFolder_parse('/home/u/uploads/a/b/c/d.dcm')).toBeNull();
    expect(pacsSeriesFolder_parse('/SERVICES/PACS/PACSDCM/1234567-X')).toBeNull();
  });
});

describe('pacsSeriesFacts_fetch', () => {
  it('asks by patient once, matches the folder exactly, and keeps only modality and description', async () => {
    const getPACSSeriesList = jest.fn(async () => list_of([
      { data: { folder_path: FOLDER, Modality: 'MR ', SeriesDescription: ' SAG MPRAGE', PatientName: 'kept nowhere' } },
      { data: { folder_path: `${FOLDER}-other`, Modality: 'CT' } },
    ]));
    mockClientGet.mockResolvedValue({ getPACSSeriesList });
    expect(await pacsSeriesFacts_fetch(`/${FOLDER}/0001.dcm`)).toEqual({ modality: 'MR', seriesDescription: 'SAG MPRAGE' });
    expect(await pacsSeriesFacts_fetch(`/${FOLDER}-other/0001.dcm`)).toEqual({ modality: 'CT' });
    expect(getPACSSeriesList).toHaveBeenCalledTimes(1);
    expect(getPACSSeriesList).toHaveBeenCalledWith(expect.objectContaining({ PatientID: '1234567', pacs_identifier: 'PACSDCM' }));
    expect(await pacsSeriesFacts_fetch(`/${FOLDER.replace('00005', '00009')}/0001.dcm`)).toBeNull();
  });

  it('answers nothing outside the PACS store and forgets a failed ask', async () => {
    const getPACSSeriesList = jest.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(list_of([{ data: { folder_path: FOLDER, Modality: 'MR' } }]));
    mockClientGet.mockResolvedValue({ getPACSSeriesList });
    expect(await pacsSeriesFacts_fetch('/home/u/x.dcm')).toBeNull();
    expect(await pacsSeriesFacts_fetch(`/${FOLDER}/1.dcm`)).toBeNull();
    expect(await pacsSeriesFacts_fetch(`/${FOLDER}/1.dcm`)).toEqual({ modality: 'MR' });
    expect(getPACSSeriesList).toHaveBeenCalledTimes(2);
  });
});

describe('a series record whose folder is not text', () => {
  it('is a failed ask, not a crash in the middle of one: nothing is answered and nothing kept', async () => {
    const getPACSSeriesList = jest.fn()
      .mockResolvedValueOnce(list_of([{ data: { folder_path: 7, Modality: 'MR' } }]))
      .mockResolvedValueOnce(list_of([{ data: { folder_path: FOLDER, Modality: {} } }]))
      .mockResolvedValueOnce(list_of([{ data: { folder_path: null } }, { data: { folder_path: FOLDER, Modality: null, SeriesDescription: 'T1' } }]));
    mockClientGet.mockResolvedValue({ getPACSSeriesList });
    expect(await pacsSeriesFacts_fetch(`/${FOLDER}/1.dcm`)).toBeNull();
    expect(await pacsSeriesFacts_fetch(`/${FOLDER}/1.dcm`)).toBeNull();
    // Absent and null are as they were: the row without a folder is passed over, a null modality is no modality.
    expect(await pacsSeriesFacts_fetch(`/${FOLDER}/1.dcm`)).toEqual({ seriesDescription: 'T1' });
    expect(getPACSSeriesList).toHaveBeenCalledTimes(3);
  });
});
