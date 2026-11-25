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

import { ListResource } from '@fnndsc/chrisapi';
import { errorStack, ChRISResource } from '@fnndsc/cumin';
import { NativeVfsProvider } from '../src/vfs/providers/native';

type Rows = Array<Record<string, unknown>>;

/** A listing served in pages, as CUBE serves one: each page's rows, in order. */
interface Paged { pages: Rows[] }

/** What one listing of one folder answers: its rows, the error its walk ends in, or real pages. */
type Answer = Rows | Error | Paged;

/**
 * One page of a collection as the SDK holds it: a real `ListResource`, whose
 * own getters read the items and the `next` link.
 *
 * @param rows - The page's rows.
 * @param more - Whether a page follows; said, as CUBE says it, by a link of rel `next`.
 * @returns The page.
 */
function page_make(rows: Rows, more: boolean): ListResource {
  const list: ListResource = Object.create(ListResource.prototype) as ListResource;
  Object.defineProperties(list, {
    collection: {
      value: {
        links: more ? [{ rel: 'next', href: 'https://cube/api/v1/next/' }] : [],
        items: rows.map((row: Record<string, unknown>) => ({
          data: Object.entries(row).map(([name, value]: [string, unknown]) => ({ name, value })),
          href: `https://cube/api/v1/rows/${String(row.id)}/`,
          links: [],
        })),
      },
    },
    getItems: { value: (): unknown[] => rows.map(() => ({})) },
  });
  return list;
}

/**
 * cumin's own resource, unchanged, over a listing served in pages.
 *
 * @param paged - The pages.
 * @returns A resource whose walk fetches them one by one, by offset.
 */
function resource_make(paged: Paged): ChRISResource {
  const resource: ChRISResource = new ChRISResource();
  resource.resourceName = 'Files';
  resource.binding_applyGet({}, (async (params: { offset?: number }) => {
    let passed: number = 0;
    for (let index: number = 0; index < paged.pages.length; index++) {
      const rows: Rows = paged.pages[index] ?? [];
      if (passed === (params.offset ?? 0)) return page_make(rows, index < paged.pages.length - 1);
      passed += rows.length;
    }
    return page_make([], false);
  }) as never);
  return resource;
}

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
    if (!Array.isArray(answer) && !(answer instanceof Error)) return { asset: resource_make(answer) };
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

  it('a file of the same name whose id is beyond the range a number holds exactly', async () => {
    cube_answer({ 'dirs /home': [folderRow], 'files /home': [{ id: 9007199254740993, fname: 'home/x' }] });
    expect(await provider.rmdir('/home/x')).toMatchObject({ ok: false, errno: 'EIO' });
    expect(deleteAsked).not.toHaveBeenCalled();
  });

  it('a file of the same name whose id is text that is not plain digits', async () => {
    cube_answer({ 'dirs /home': [folderRow], 'files /home': [{ id: '1e3', fname: 'home/x' }] });
    expect(await provider.rmdir('/home/x')).toMatchObject({ ok: false, errno: 'EIO' });
    expect(deleteAsked).not.toHaveBeenCalled();
  });

  it('a file of the same name that is on the second page of the parent\'s files', async () => {
    const others: Rows = Array.from({ length: 3 }, (_unused: unknown, index: number) => ({ id: 100 + index, fname: `home/other-${index}` }));
    cube_answer({ 'dirs /home': [folderRow], 'files /home': { pages: [others, [{ id: 31, fname: 'home/x' }]] } });
    expect(await provider.rmdir('/home/x')).toEqual({
      ok: false, errno: 'EPERM', reason: 'a folder and a file share /home/x, and removing either would damage the other in CUBE',
    });
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
