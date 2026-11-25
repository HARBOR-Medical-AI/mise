/**
 * @file A folder upload asks, or stops, before anything is sent.
 *
 * The lookup is real: salsa's `pathHolders_prove` and its strict listing run,
 * and only cumin's resource group is a stand-in, one per listing of one
 * folder. So what is proved here is the whole way from "CUBE answered this"
 * to "this many files were sent", and the number sent is what every case
 * asserts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockObjCreate = jest.fn();
const mockUpload = jest.fn();

jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  objContext_create: mockObjCreate,
  chrisIO: { client_get: jest.fn(), file_upload: mockUpload },
}));
jest.mock('../../../src/utils/cli', () => ({
  path_resolveChrisFs: async (where: string | undefined): Promise<string> => where ?? '/',
}));
jest.mock('../../../src/utils/input_format', () => ({ prompt_confirmOrThrow: jest.fn() }));

import { files_uploadWithProgress } from '../../../src/commands/fs/upload';
import { prompt_confirmOrThrow } from '../../../src/utils/input_format';

type Rows = Array<Record<string, unknown>>;

/** What one listing of one folder answers: its rows, an error its walk ends in, or no listing at all. */
type Answer = Rows | Error | 'unmade';

/**
 * Stands in for cumin's resource groups.
 *
 * @param answers - Keyed `<dirs|files|links> <folder>`. A listing not named
 *   answers in full and holds nothing.
 */
function cube_answer(answers: Record<string, Answer>): void {
  const contexts: Record<string, string> = { ChRISDirsContext: 'dirs', ChRISFilesContext: 'files', ChRISLinksContext: 'links' };
  mockObjCreate.mockImplementation(async (context: string, where: string) => {
    const answer: Answer = answers[`${contexts[context]} ${where.replace(/^folder:/, '')}`] ?? [];
    if (answer === 'unmade') return null;
    return {
      asset: {
        resources_getWhole: async (): Promise<{ tableData: Rows; selectedFields: string[]; totalCount: number }> => {
          if (answer instanceof Error) throw answer;
          return { tableData: answer, selectedFields: [], totalCount: answer.length };
        },
      },
    };
  });
}

/** A parent that is there: its own parent lists it as a folder. */
const REMOTE_IS_THERE: Record<string, Answer> = { 'dirs /': [{ id: 2, path: 'remote' }] };

let tmpDir: string;

/**
 * Makes a folder on this machine holding one file.
 *
 * @param name - The folder's name.
 * @returns Its path.
 */
async function folder_make(name: string): Promise<string> {
  const made: string = path.join(tmpDir, name);
  await fs.promises.mkdir(made);
  await fs.promises.writeFile(path.join(made, 'scan.dcm'), 'scan');
  return made;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockUpload.mockResolvedValue(true);
  (prompt_confirmOrThrow as jest.Mock).mockResolvedValue(undefined);
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chili-consent-'));
});

describe('a folder upload sends nothing', () => {
  it('when the operator says no', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'dirs /remote': [{ id: 4, path: 'remote/study' }] });
    const confirm = jest.fn(async (): Promise<void> => { throw new Error('Operation cancelled by user.'); });
    await expect(files_uploadWithProgress(local, '/remote', { confirm })).rejects.toThrow('Operation cancelled by user.');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('when the question cannot be asked', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'dirs /remote': [{ id: 4, path: 'remote/study' }] });
    (prompt_confirmOrThrow as jest.Mock).mockRejectedValue(new Error('Target exists. Use --force to skip confirmation.'));
    await expect(files_uploadWithProgress(local, '/remote')).rejects.toThrow('Use --force to skip confirmation.');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('when CUBE refuses to list the place it would land in', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'files /remote': new Error('500 Internal Server Error') });
    const failure: Promise<unknown> = files_uploadWithProgress(local, '/remote');
    await expect(failure).rejects.toThrow("Cannot tell whether '/remote/study' is already in ChRIS (Cannot check /remote/study: 500 Internal Server Error). Nothing was uploaded.");
    await expect(failure).rejects.not.toThrow('--force');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('when a listing of that place could not be made though the place is there', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'files /remote': 'unmade' });
    await expect(files_uploadWithProgress(local, '/remote')).rejects.toThrow('/remote is there and could not be listed');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('when a listing of that place came back as a list with no items', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'dirs /remote': new Error('Dirs: the list at offset 0 carries no items') });
    await expect(files_uploadWithProgress(local, '/remote')).rejects.toThrow('carries no items');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('when a file holds the path the folder would take', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'files /remote': [{ id: 9, fname: 'remote/study' }] });
    await expect(files_uploadWithProgress(local, '/remote')).rejects.toThrow("A file already holds '/remote/study' in ChRIS, and a folder cannot be uploaded onto it. Nothing was uploaded.");
    expect(prompt_confirmOrThrow).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('when a folder and a link share that path: the question is not even asked', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'dirs /remote': [{ id: 4, path: 'remote/study' }], 'links /remote': [{ id: 5, fname: 'remote/study.chrislink' }] });
    await expect(files_uploadWithProgress(local, '/remote')).rejects.toThrow("A link already holds '/remote/study'");
    expect(prompt_confirmOrThrow).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('from the first of two folders when the second is declined', async () => {
    await folder_make('alpha');
    await folder_make('beta');
    cube_answer({ ...REMOTE_IS_THERE, 'dirs /remote': [{ id: 4, path: 'remote/beta' }] });
    const confirm = jest.fn(async (): Promise<void> => { throw new Error('Operation cancelled by user.'); });
    await expect(files_uploadWithProgress(path.join(tmpDir, '*'), '/remote', { confirm })).rejects.toThrow('Operation cancelled by user.');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Target '/remote/beta' already exists"));
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('a folder upload goes ahead', () => {
  it('with no question when nothing holds its place', async () => {
    const local: string = await folder_make('study');
    cube_answer(REMOTE_IS_THERE);
    const summary = await files_uploadWithProgress(local, '/remote');
    expect(prompt_confirmOrThrow).not.toHaveBeenCalled();
    expect(summary.transferredCount).toBe(1);
  });

  it('with no question into a place whose parent is not there yet, once that absence is proved', async () => {
    const local: string = await folder_make('study');
    cube_answer({ 'dirs /new': 'unmade', 'files /new': 'unmade', 'links /new': 'unmade' });
    const summary = await files_uploadWithProgress(local, '/new');
    expect(prompt_confirmOrThrow).not.toHaveBeenCalled();
    expect(summary.transferredCount).toBe(1);
  });

  it('after a yes, and an existing folder that holds nothing is still asked about', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'dirs /remote': [{ id: 4, path: 'remote/study' }] });
    const confirm = jest.fn(async (): Promise<void> => undefined);
    const summary = await files_uploadWithProgress(local, '/remote', { confirm });
    expect(confirm).toHaveBeenCalledWith("Target '/remote/study' already exists in ChRIS. Merge/overwrite? (y/N)");
    expect(summary.transferredCount).toBe(1);
  });

  it('with no lookup and no question under --force', async () => {
    const local: string = await folder_make('study');
    cube_answer({ ...REMOTE_IS_THERE, 'files /remote': new Error('500 Internal Server Error') });
    const summary = await files_uploadWithProgress(local, '/remote', { force: true });
    expect(mockObjCreate).not.toHaveBeenCalled();
    expect(prompt_confirmOrThrow).not.toHaveBeenCalled();
    expect(summary.transferredCount).toBe(1);
  });
});

describe('a single file', () => {
  it('goes into an existing folder with no lookup and no question', async () => {
    const local: string = path.join(tmpDir, 'scan.dcm');
    await fs.promises.writeFile(local, 'scan');
    cube_answer({ ...REMOTE_IS_THERE, 'files /remote': new Error('500 Internal Server Error') });
    const summary = await files_uploadWithProgress(local, '/remote');
    expect(mockObjCreate).not.toHaveBeenCalled();
    expect(prompt_confirmOrThrow).not.toHaveBeenCalled();
    expect(summary.transferredCount).toBe(1);
  });
});
