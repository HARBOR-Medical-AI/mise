/**
 * @file A rewrite, from salsa's public write down to cumin's move.
 *
 * `replace.test.ts` replaces every cumin file call, so it cannot see what
 * cumin's own move does between two requests. Here `files_touch`, the swap,
 * the strict lookup and cumin's `file_moveById`, `file_locate` and
 * `file_deleteById` are all real. Only the SDK client beneath them is a
 * stand-in, over a store held in memory, and the upload, which answers as
 * CUBE does: with the stored path from the root.
 */
interface StoredFile { path: string; content: string }

/** What one PUT is made to do, by its place in the order of all PUTs. */
type PutFate = (id: number, body: Record<string, unknown>) => void;

const mockStore: {
  files: Map<number, StoredFile>;
  nextId: number;
  puts: Array<{ id: number; body: Record<string, unknown> }>;
  putFates: Map<number, PutFate>;
  legacyOnly: boolean;
  deleted: number[];
  listings: number;
  listingFaults: Set<number>;
} = { files: new Map(), nextId: 100, puts: [], putFates: new Map(), legacyOnly: false, deleted: [], listings: 0, listingFaults: new Set() };

/** Puts a file in the store. */
function mockFile_put(path: string, content: string): number {
  const id: number = mockStore.nextId++;
  mockStore.files.set(id, { path, content });
  return id;
}

/** CUBE's refusal of a rename field it does not know. */
function mockRefusal_field(): Error {
  return Object.assign(new Error('Bad Request'), { response: { status: 400, data: { path: ['This field is required.'] } } });
}

/** The SDK client: a file by id, with the rename and the delete it offers. */
const mockClient = {
  getUserFile: async (id: number) => {
    const file: StoredFile | undefined = mockStore.files.get(id);
    if (file === undefined) return null;
    return {
      data: { fname: file.path.slice(1) },
      put: async (body: Record<string, unknown>): Promise<void> => {
        mockStore.puts.push({ id, body });
        const fate: PutFate | undefined = mockStore.putFates.get(mockStore.puts.length);
        if (fate !== undefined) fate(id, body);
        if (mockStore.legacyOnly && body.path === undefined) throw mockRefusal_field();
        (mockStore.files.get(id) as StoredFile).path = String(body.upload_path ?? body.path);
      },
      _delete: async (): Promise<void> => {
        mockStore.deleted.push(id);
        mockStore.files.delete(id);
      },
    };
  },
};

/** The folders that are there: the root and /a. Any other could not be listed at all. */
const mockObjCreate = jest.fn(async (context: string, where: string) => {
  const folder: string = where.replace(/^folder:/, '');
  if (folder !== '/' && folder !== '/a') return null;
  const rows = (): Array<Record<string, unknown>> => {
    if (context === 'ChRISDirsContext') return folder === '/' ? [{ id: 1, path: 'a' }] : [];
    if (context !== 'ChRISFilesContext') return [];
    return [...mockStore.files.entries()]
      .filter(([, file]: [number, StoredFile]): boolean => file.path.slice(0, file.path.lastIndexOf('/')) === folder)
      .map(([id, file]: [number, StoredFile]) => ({ id, fname: file.path.slice(1) }));
  };
  return {
    asset: {
      resources_getWhole: async () => {
        if (context === 'ChRISFilesContext' && folder === '/a') {
          mockStore.listings += 1;
          if (mockStore.listingFaults.has(mockStore.listings)) throw new Error('Files: the answer at offset 100 is not a list');
        }
        return { tableData: rows(), selectedFields: [], totalCount: rows().length };
      },
    },
  };
});

jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  objContext_create: mockObjCreate,
  chrisContext: { current_get: jest.fn() },
}));
jest.mock('../src/vfs/dispatcher', () => ({ vfsDispatcher: { path_isVirtual: (): boolean => false } }));

import { chrisIO, errorStack, Ok } from '@fnndsc/cumin';
import { files_touch } from '../src/files/index';
import { file_replace } from '../src/files/replace';

const NAME: string = '/a/notes.txt';
let oldId: number;

/** The content at a path, or undefined when nothing is there. */
function content_at(path: string): string | undefined {
  return [...mockStore.files.values()].find((file: StoredFile): boolean => file.path === path)?.content;
}

/** The one path in the store carrying a mark. */
function leftover_find(mark: 'mise-new' | 'mise-old'): string {
  return [...mockStore.files.values()].map((file: StoredFile): string => file.path).find((path: string): boolean => path.includes(mark)) ?? `<no ${mark} file>`;
}

/** The PUTs asked for one file. */
function puts_of(id: number): Array<Record<string, unknown>> {
  return mockStore.puts.filter((put: { id: number }): boolean => put.id === id).map((put: { body: Record<string, unknown> }) => put.body);
}

beforeEach(() => {
  jest.restoreAllMocks();
  errorStack.stack_clear();
  Object.assign(mockStore, { files: new Map(), nextId: 100, puts: [], putFates: new Map(), legacyOnly: false, deleted: [], listings: 0, listingFaults: new Set() });
  oldId = mockFile_put(NAME, 'old');
  jest.spyOn(chrisIO, 'client_get').mockResolvedValue(mockClient as never);
  // The upload answers as CUBE does: the stored path, from the root, whatever spelling it was asked with.
  jest.spyOn(chrisIO, 'file_uploadReceipted').mockImplementation(async (blob: Blob, dir: string, name: string) => {
    const stored: string = `/${`${dir}/${name}`.replace(/^\/+/, '')}`;
    return Ok({ id: mockFile_put(stored, await blob.text()), path: stored });
  });
});

describe('a second request for one move is made only after a second look', () => {
  it('a CUBE that takes only the older field: the rewrite completes, each move asked twice', async () => {
    mockStore.legacyOnly = true;
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(true);
    expect(content_at(NAME)).toBe('new');
    expect(puts_of(oldId)).toEqual([{ upload_path: expect.any(String) }, { path: expect.any(String) }]);
    expect(mockStore.deleted).toEqual([oldId]);
  });

  it('the name cannot be shown free the second time, once the old file is aside: both copies stay, nothing is undone', async () => {
    const newId: number = mockStore.nextId;
    // PUT 2 is the new content's move onto the name; CUBE refuses its field.
    mockStore.putFates.set(2, (): void => { throw mockRefusal_field(); });
    // Proofs of a path in /a: the set-aside name, the name, then the name again before the second request.
    mockStore.listingFaults.add(3);
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(puts_of(newId)).toHaveLength(1);
    expect(puts_of(oldId)).toHaveLength(1);
    expect(mockStore.deleted).toEqual([]);
    expect(content_at(leftover_find('mise-old'))).toBe('old');
    expect(content_at(leftover_find('mise-new'))).toBe('new');
    expect(errorStack.stack_search('the name was held or could not be checked').length).toBe(1);
  });

  it('the file was moved elsewhere between the two requests: no second request, nothing removed', async () => {
    const newId: number = mockStore.nextId;
    mockStore.putFates.set(2, (id: number): void => {
      (mockStore.files.get(id) as StoredFile).path = '/a/taken-by-another.txt';
      throw mockRefusal_field();
    });
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(puts_of(newId)).toHaveLength(1);
    expect(mockStore.deleted).toEqual([]);
    expect(content_at('/a/taken-by-another.txt')).toBe('new');
    expect(content_at(leftover_find('mise-old'))).toBe('old');
  });

  it('a 400 that is not about the field is the answer: one request, and the old file goes back', async () => {
    const newId: number = mockStore.nextId;
    mockStore.putFates.set(2, (): void => {
      throw Object.assign(new Error('Bad Request'), { response: { status: 400, data: { detail: 'Invalid file name.' } } });
    });
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(puts_of(newId)).toHaveLength(1);
    expect(content_at(NAME)).toBe('old');
    expect(mockStore.files.get(oldId)?.path).toBe(NAME);
    expect(mockStore.deleted).toEqual([newId]);
  });
});

describe('a path written without its leading slash is the same path', () => {
  it('a first write lands, is recognised as the write asked for, and is not removed as a stray', async () => {
    expect(await files_touch('a/fresh.txt', 'first')).toBe(true);
    expect(content_at('/a/fresh.txt')).toBe('first');
    expect(mockStore.deleted).toEqual([]);
    expect(mockStore.puts).toEqual([]);
  });

  it('a rewrite replaces the file that is there', async () => {
    expect(await files_touch('a/notes.txt', 'new')).toBe(true);
    expect(content_at(NAME)).toBe('new');
    expect(mockStore.deleted).toEqual([oldId]);
    expect(mockStore.files.size).toBe(1);
  });

  it('a first write under folders that are not there yet ends: the walk up reaches the root', async () => {
    expect(await files_touch('new/deep/file.txt', 'first')).toBe(true);
    expect(content_at('/new/deep/file.txt')).toBe('first');
  });
});
