/**
 * pathFileId_resolve: a file's id from its folder's listing; inside
 * fileIds_memoRun each folder is listed once, shared by reads in flight
 * together, and a folder that cannot be listed is listed again.
 */
const mockGetGroup = jest.fn();

jest.mock('../src/files/index', () => ({ files_getGroup: mockGetGroup }));

import { errorStack } from '@fnndsc/cumin';
import { fileIds_memoRun, pathFileId_resolve } from '../src/files/fileLookup';

/** A folder listing of the given rows, counted. */
const listings: jest.Mock = jest.fn();

function folderWith(rows: unknown[] | null): void {
  listings.mockImplementation(async () => {
    await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 2); });
    return rows === null ? null : { tableData: rows };
  });
  mockGetGroup.mockResolvedValue({ asset: { resources_getAll: listings } });
}

beforeEach(() => {
  jest.clearAllMocks();
  errorStack.stack_clear();
});

describe('pathFileId_resolve', () => {
  it('finds a file by basename, the ? placeholder form too, and lists afresh outside a transfer', async () => {
    folderWith([{ id: 7, fname: '/d/a.dcm' }, { id: 8, fname: '/d/? b.dcm' }]);
    expect(await pathFileId_resolve('/d/a.dcm')).toEqual({ ok: true, value: 7 });
    expect(await pathFileId_resolve('/d/b.dcm')).toEqual({ ok: true, value: 8 });
    expect(listings).toHaveBeenCalledTimes(2);
  });

  it('says what is missing: the file, its id, or the folder', async () => {
    folderWith([{ fname: '/d/noid.dcm' }]);
    expect((await pathFileId_resolve('/d/gone.dcm')).ok).toBe(false);
    expect((await pathFileId_resolve('/d/noid.dcm')).ok).toBe(false);
    folderWith(null);
    expect((await pathFileId_resolve('/d/a.dcm')).ok).toBe(false);
    mockGetGroup.mockResolvedValue(null);
    expect((await pathFileId_resolve('/d/a.dcm')).ok).toBe(false);
    const said: string[] = errorStack.stack_getAll().map((note: { message: string }): string => note.message);
    expect(said.some((line: string): boolean => line.includes('File not found: gone.dcm in /d'))).toBe(true);
    expect(said.some((line: string): boolean => line.includes('File has no valid ID: noid.dcm'))).toBe(true);
    expect(said.some((line: string): boolean => line.includes('No files found in directory: /d'))).toBe(true);
  });

  it('inside a transfer lists each folder once, shared by reads in flight together', async () => {
    const rows: unknown[] = Array.from({ length: 20 }, (_: unknown, index: number) => ({ id: 100 + index, fname: `/d/f${index}.dcm` }));
    folderWith(rows);
    const ids: number[] = await fileIds_memoRun(async () => {
      const found = await Promise.all(rows.map((_: unknown, index: number) => pathFileId_resolve(`/d/f${index}.dcm`)));
      const again = await pathFileId_resolve('/d/f3.dcm');
      return [...found, again].map((one) => (one.ok ? one.value : -1));
    });
    expect(ids.slice(0, 3)).toEqual([100, 101, 102]);
    expect(ids[20]).toBe(103);
    expect(listings).toHaveBeenCalledTimes(1);
    // A nested scope shares the outer one; after the transfer nothing is kept.
    await fileIds_memoRun(async () => fileIds_memoRun(async () => pathFileId_resolve('/d/f1.dcm')));
    expect(listings).toHaveBeenCalledTimes(2);
  });

  it('inside a transfer lists again a folder that could not be listed', async () => {
    folderWith(null);
    await fileIds_memoRun(async () => {
      expect((await pathFileId_resolve('/d/a.dcm')).ok).toBe(false);
      folderWith([{ id: 9, fname: '/d/a.dcm' }]);
      expect(await pathFileId_resolve('/d/a.dcm')).toEqual({ ok: true, value: 9 });
    });
  });
});
