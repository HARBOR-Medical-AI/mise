/**
 * @file rmdir, from the provider down to the collection walk.
 *
 * The contract test replaces salsa's file functions with a CUBE held in
 * memory, so it cannot see what those functions make of a bad answer from
 * cumin. Here they are real: the native provider, the proofs and the strict
 * listing all run, and only cumin's resource group is a stand-in, one per
 * listing of one folder. Each case is an answer that once read as "empty",
 * and each asserts that no delete was asked for.
 */
const mockObjCreate = jest.fn();
const mockIO = { file_deleteById: jest.fn(), folder_deleteByPath: jest.fn() };

jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  objContext_create: mockObjCreate,
  chrisContext: { current_get: jest.fn() },
  chrisIO: mockIO,
}));
jest.mock('../src/vfs/dispatcher', () => ({ vfsDispatcher: { path_isVirtual: (): boolean => false } }));

import { errorStack } from '@fnndsc/cumin';
import { NativeVfsProvider } from '../src/vfs/providers/native';

type Rows = Array<Record<string, unknown>>;

/** What one listing of one folder answers: its rows, or the error its walk ends in. */
type Answer = Rows | Error;

/** Every delete any stand-in was asked for. */
const deleteAsked = jest.fn();

/**
 * Stands in for cumin's resource groups: one answer per listing of a folder.
 *
 * @param answers - Keyed `<dirs|files|links> <folder>`; a listing not named
 *   holds nothing and answers in full.
 */
function cube_answer(answers: Record<string, Answer>): void {
  const contexts: Record<string, string> = { ChRISDirsContext: 'dirs', ChRISFilesContext: 'files', ChRISLinksContext: 'links' };
  mockObjCreate.mockImplementation(async (context: string, where: string) => {
    const answer: Answer = answers[`${contexts[context]} ${where.replace(/^folder:/, '')}`] ?? [];
    return {
      asset: {
        resources_getWhole: async (): Promise<{ tableData: Rows; selectedFields: string[]; totalCount: number }> => {
          if (answer instanceof Error) throw answer;
          return { tableData: answer, selectedFields: [], totalCount: answer.length };
        },
        resources_getAll: async (): Promise<null> => null,
        resourceItem_delete: deleteAsked,
      },
    };
  });
}

/** The reason left on the error stack, without its level prefix. */
function reason_read(outcome: unknown): string {
  return String((outcome as { reason?: string }).reason ?? '');
}

const provider = new NativeVfsProvider();
const folderRow = { id: 7, path: 'home/x' };

beforeEach(() => {
  jest.clearAllMocks();
  errorStack.stack_clear();
});

describe('rmdir asks for no delete on an answer that only looks like "empty"', () => {
  it('a files listing of the folder that is a list with no items in it', async () => {
    cube_answer({ 'dirs /home': [folderRow], 'files /home/x': new Error('Files: the list at offset 0 carries no items') });
    const outcome = await provider.rmdir('/home/x');
    expect(outcome).toMatchObject({ ok: false, errno: 'EIO' });
    expect(reason_read(outcome)).toContain('carries no items');
    expect(deleteAsked).not.toHaveBeenCalled();
  });

  it('a parent listing whose second page could not be read, where a file of the same name may be', async () => {
    cube_answer({ 'dirs /home': [folderRow], 'files /home': new Error('Files: the answer at offset 100 is not a list') });
    const outcome = await provider.rmdir('/home/x');
    expect(outcome).toMatchObject({ ok: false, errno: 'EIO' });
    expect(reason_read(outcome)).toContain('is not a list');
    expect(deleteAsked).not.toHaveBeenCalled();
  });

  it('a file of the same name whose row carries no id', async () => {
    cube_answer({ 'dirs /home': [folderRow], 'files /home': [{ fname: 'home/x' }] });
    const outcome = await provider.rmdir('/home/x');
    expect(outcome).toEqual({ ok: false, errno: 'EIO', reason: 'Cannot check /home/x: the file of that name in /home has no usable id' });
    expect(deleteAsked).not.toHaveBeenCalled();
  });

  it('a file of the same name whose id is null', async () => {
    cube_answer({ 'dirs /home': [folderRow], 'files /home': [{ id: null, fname: 'home/x' }] });
    expect(await provider.rmdir('/home/x')).toMatchObject({ ok: false, errno: 'EIO' });
    expect(deleteAsked).not.toHaveBeenCalled();
  });

  it('a row of the parent that has no name, which could be the folder asked about or its twin', async () => {
    cube_answer({ 'dirs /home': [folderRow], 'files /home': [{ id: 9 }] });
    const outcome = await provider.rmdir('/home/x');
    expect(outcome).toEqual({ ok: false, errno: 'EIO', reason: 'Cannot check /home/x: a row among the files of /home has no name' });
    expect(deleteAsked).not.toHaveBeenCalled();
  });

  it('a folder that holds a row, however little the row says', async () => {
    cube_answer({ 'dirs /home': [folderRow], 'files /home/x': [{}] });
    expect(await provider.rmdir('/home/x')).toEqual({ ok: false, errno: 'ENOTEMPTY' });
    expect(deleteAsked).not.toHaveBeenCalled();
  });
});

describe('a name is the name its folder gives it', () => {
  it('finds a folder whose own name ends in .chrislink, and asks for its delete by its id', async () => {
    cube_answer({ 'dirs /home': [{ id: 12, path: 'home/reports.chrislink' }] });
    deleteAsked.mockResolvedValue(true);
    await provider.rmdir('/home/reports.chrislink');
    expect(deleteAsked).toHaveBeenCalledWith(12);
  });

  it('does not take a folder named reports.chrislink for one named reports', async () => {
    cube_answer({ 'dirs /home': [{ id: 12, path: 'home/reports.chrislink' }] });
    expect(await provider.rmdir('/home/reports')).toEqual({ ok: false, errno: 'ENOENT' });
    expect(deleteAsked).not.toHaveBeenCalled();
  });

  it('still reads a link by its name without CUBE\'s .chrislink mark, and refuses it as not a folder', async () => {
    cube_answer({ 'links /home': [{ id: 5, fname: 'home/shared.chrislink', path: 'SHARED/data' }] });
    expect(await provider.rmdir('/home/shared')).toEqual({ ok: false, errno: 'ENOTDIR' });
    expect(deleteAsked).not.toHaveBeenCalled();
  });
});
