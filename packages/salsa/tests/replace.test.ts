/**
 * @file A rewrite keeps the old content recoverable until the new is in place.
 *
 * `file_replace` and the strict lookup it leans on are real. cumin's file
 * calls are replaced by a store held in memory, keyed by file id and holding
 * each file's path and content, so every case asserts which file is where
 * and what it says, and not the order of the calls. The store can be told to
 * fail a call, to do a move and lose its reply, and to let another file
 * appear at a path between two steps.
 */
interface StoredFile { path: string; content: string }

/** A move's fate: not done and an error, or done and the reply lost. */
type MoveFault = 'fails' | 'replyLost';

const mockStore: {
  files: Map<number, StoredFile>;
  nextId: number;
  moves: number;
  moveFaults: Map<number, MoveFault>;
  afterMove: Map<number, () => void>;
  uploadFault: 'fails' | 'landsElsewhere' | null;
  unlocatable: Set<number>;
  undeletable: Set<number>;
  deleted: number[];
  moveAsked: Array<{ id: number; to: string }>;
} = {
  files: new Map(), nextId: 100, moves: 0, moveFaults: new Map(), afterMove: new Map(),
  uploadFault: null, unlocatable: new Set(), undeletable: new Set(), deleted: [], moveAsked: [],
};

/** Puts a file in the store. */
function mockFile_put(path: string, content: string): number {
  const id: number = mockStore.nextId++;
  mockStore.files.set(id, { path, content });
  return id;
}

const mockIO = {
  file_uploadReceipted: jest.fn(async (blob: Blob, dir: string, name: string) => {
    if (mockStore.uploadFault === 'fails') return { ok: false };
    let path: string = `${dir}/${name}`;
    if (mockStore.uploadFault === 'landsElsewhere') {
      // The staging name is taken, and CUBE stores the bytes under another.
      mockFile_put(path, 'somebody else\'s');
      path = `${path}_a1b2c3`;
    }
    return { ok: true, value: { id: mockFile_put(path, await blob.text()), path } };
  }),
  file_moveById: jest.fn(async (id: number, to: string) => {
    mockStore.moves += 1;
    mockStore.moveAsked.push({ id, to });
    const fault: MoveFault | undefined = mockStore.moveFaults.get(mockStore.moves);
    const file: StoredFile | undefined = mockStore.files.get(id);
    if (fault !== 'fails' && file !== undefined) file.path = to;
    mockStore.afterMove.get(mockStore.moves)?.();
    return fault === undefined ? { ok: true, value: true } : { ok: false };
  }),
  file_locate: jest.fn(async (id: number) => {
    if (mockStore.unlocatable.has(id)) return { ok: false };
    return { ok: true, value: mockStore.files.get(id)?.path ?? null };
  }),
  file_deleteById: jest.fn(async (id: number) => {
    if (mockStore.undeletable.has(id)) return { ok: false };
    mockStore.deleted.push(id);
    mockStore.files.delete(id);
    return { ok: true, value: true };
  }),
};

/** The store's folders as the strict lookup lists them: every file lives in /a, a folder of the root. */
const mockObjCreate = jest.fn(async (context: string, where: string) => {
  const folder: string = where.replace(/^folder:/, '');
  const rows = (): Array<Record<string, unknown>> => {
    if (context === 'ChRISDirsContext') return folder === '/' ? [{ id: 1, path: 'a' }] : [];
    if (context !== 'ChRISFilesContext') return [];
    return [...mockStore.files.entries()]
      .filter(([, file]: [number, StoredFile]): boolean => file.path.slice(0, file.path.lastIndexOf('/')) === folder)
      .map(([id, file]: [number, StoredFile]) => ({ id, fname: file.path.slice(1) }));
  };
  return { asset: { resources_getWhole: async () => ({ tableData: rows(), selectedFields: [], totalCount: rows().length }) } };
});

jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  objContext_create: mockObjCreate,
  chrisContext: { current_get: jest.fn() },
  chrisIO: mockIO,
}));
jest.mock('../src/vfs/dispatcher', () => ({ vfsDispatcher: { path_isVirtual: (): boolean => false } }));

import { errorStack } from '@fnndsc/cumin';
import { file_replace } from '../src/files/replace';

const NAME: string = '/a/notes.txt';
let oldId: number;

/** The content at a path, or undefined when nothing is there; fails the test if two files are. */
function content_at(path: string): string | undefined {
  const there: StoredFile[] = [...mockStore.files.values()].filter((file: StoredFile): boolean => file.path === path);
  expect(there.length).toBeLessThanOrEqual(1);
  return there[0]?.content;
}

/** Every path in the store that is a staging or set-aside name. */
function leftovers_list(): string[] {
  return [...mockStore.files.values()].map((file: StoredFile): string => file.path).filter((path: string): boolean => path.includes('.mise-'));
}

/** The one path in the store matching a mark, for an error that must name it. */
function leftover_find(mark: 'mise-new' | 'mise-old'): string {
  return leftovers_list().find((path: string): boolean => path.includes(mark)) ?? `<no ${mark} file>`;
}

/** Whether any message on the error stack holds every one of the words. */
function stack_says(...words: string[]): boolean {
  return errorStack.stack_search(words[0] ?? '').some((message: string): boolean => words.every((word: string): boolean => message.includes(word)));
}

beforeEach(() => {
  jest.clearAllMocks();
  errorStack.stack_clear();
  Object.assign(mockStore, {
    files: new Map(), nextId: 100, moves: 0, moveFaults: new Map(), afterMove: new Map(),
    uploadFault: null, unlocatable: new Set(), undeletable: new Set(), deleted: [], moveAsked: [],
  });
  oldId = mockFile_put(NAME, 'old');
});

describe('a rewrite that goes well', () => {
  it('leaves the new content at the name under a new id, and neither a staged nor a set-aside file', async () => {
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(true);
    expect(content_at(NAME)).toBe('new');
    expect(mockStore.files.has(oldId)).toBe(false);
    expect(leftovers_list()).toEqual([]);
    expect(mockStore.deleted).toEqual([oldId]);
  });

  it('is still a success when the set-aside old file cannot be removed, and says where it is', async () => {
    mockStore.undeletable.add(oldId);
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(true);
    expect(content_at(NAME)).toBe('new');
    expect(stack_says('the old content was left at', leftover_find('mise-old'))).toBe(true);
  });
});

describe('a rewrite that fails leaves the old content at the name', () => {
  it('when the new content cannot be stored', async () => {
    mockStore.uploadFault = 'fails';
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(content_at(NAME)).toBe('old');
    expect(mockStore.files.get(oldId)?.path).toBe(NAME);
    expect(mockStore.moveAsked).toEqual([]);
    expect(mockStore.deleted).toEqual([]);
  });

  it('when the staging name is taken and the new content lands elsewhere: the occupant is not touched, the stray is removed by its id', async () => {
    mockStore.uploadFault = 'landsElsewhere';
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(content_at(NAME)).toBe('old');
    const occupant: string = leftover_find('mise-new');
    expect(content_at(occupant)).toBe('somebody else\'s');
    expect([...mockStore.files.values()].some((file: StoredFile): boolean => file.content === 'new')).toBe(false);
    expect(mockStore.moveAsked).toEqual([]);
    expect(mockStore.deleted).toHaveLength(1);
  });

  it('when the old file cannot be set aside: the staged content is removed', async () => {
    mockStore.moveFaults.set(1, 'fails');
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(content_at(NAME)).toBe('old');
    expect(mockStore.files.get(oldId)?.path).toBe(NAME);
    expect(leftovers_list()).toEqual([]);
  });

  it('when the new content cannot be moved onto the name: the old file is moved back, by its id', async () => {
    mockStore.moveFaults.set(2, 'fails');
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(content_at(NAME)).toBe('old');
    expect(mockStore.files.get(oldId)?.path).toBe(NAME);
    expect(leftovers_list()).toEqual([]);
    expect(mockStore.deleted).not.toContain(oldId);
  });
});

describe('a move that happened though its reply was lost is not undone', () => {
  it('setting the old file aside: the rewrite goes on and completes', async () => {
    mockStore.moveFaults.set(1, 'replyLost');
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(true);
    expect(content_at(NAME)).toBe('new');
    expect(leftovers_list()).toEqual([]);
  });

  it('moving the new content onto the name: the rewrite completes and the set-aside file goes', async () => {
    mockStore.moveFaults.set(2, 'replyLost');
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(true);
    expect(content_at(NAME)).toBe('new');
    expect(mockStore.files.has(oldId)).toBe(false);
    expect(leftovers_list()).toEqual([]);
  });
});

describe('when it is not known where a file is, nothing is removed and the paths are named', () => {
  it('the new content after its move: the old stays set aside, the new stays wherever it is', async () => {
    mockIO.file_uploadReceipted.mockImplementationOnce(async (blob: Blob, dir: string, name: string) => {
      const id: number = mockFile_put(`${dir}/${name}`, await blob.text());
      mockStore.unlocatable.add(id);
      return { ok: true, value: { id, path: `${dir}/${name}` } };
    });
    mockStore.moveFaults.set(2, 'fails');
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(mockStore.deleted).toEqual([]);
    expect(content_at(leftover_find('mise-old'))).toBe('old');
    expect(content_at(leftover_find('mise-new'))).toBe('new');
    expect(stack_says('it is not known whether the new content reached it', leftover_find('mise-old'), leftover_find('mise-new'))).toBe(true);
  });

  it('the old file after its move: neither it nor the staged content is removed', async () => {
    mockStore.unlocatable.add(oldId);
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(mockStore.deleted).toEqual([]);
    expect([...mockStore.files.values()].map((file: StoredFile): string => file.content).sort()).toEqual(['new', 'old']);
    expect(stack_says('it is not known whether the file there was set aside', leftover_find('mise-new'))).toBe(true);
  });

  it('the old file cannot be moved back: it stays set aside, and the error says where', async () => {
    mockStore.moveFaults.set(2, 'fails');
    mockStore.moveFaults.set(3, 'fails');
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(mockStore.deleted).toEqual([]);
    expect(content_at(leftover_find('mise-old'))).toBe('old');
    expect(content_at(leftover_find('mise-new'))).toBe('new');
    expect(stack_says('the old content could not be put back', leftover_find('mise-old'), leftover_find('mise-new'))).toBe(true);
  });
});

describe('nothing is ever moved onto a path another file holds', () => {
  it('a file that appears at the name once the old one is set aside is not moved onto, and is not touched', async () => {
    mockStore.afterMove.set(1, (): void => { mockFile_put(NAME, 'arrived meanwhile'); });
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    // One move was asked for, the setting aside. Neither the new content nor
    // the old was then moved onto the name.
    expect(mockStore.moveAsked).toHaveLength(1);
    expect(content_at(NAME)).toBe('arrived meanwhile');
    expect(mockStore.deleted).toEqual([]);
    expect(content_at(leftover_find('mise-old'))).toBe('old');
    expect(content_at(leftover_find('mise-new'))).toBe('new');
    expect(stack_says('the old content could not be put back', leftover_find('mise-old'), leftover_find('mise-new'))).toBe(true);
  });

  it('a file that appears at the name before the old one can be moved back: the old stays set aside', async () => {
    mockStore.moveFaults.set(2, 'fails');
    mockStore.afterMove.set(2, (): void => { mockFile_put(NAME, 'arrived meanwhile'); });
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(mockStore.moveAsked).toHaveLength(2);
    expect(content_at(NAME)).toBe('arrived meanwhile');
    expect(mockStore.deleted).toEqual([]);
    expect(content_at(leftover_find('mise-old'))).toBe('old');
    expect(content_at(leftover_find('mise-new'))).toBe('new');
  });

  it('the set-aside name, if somebody holds it, is not moved onto either', async () => {
    mockIO.file_uploadReceipted.mockImplementationOnce(async (blob: Blob, dir: string, name: string) => {
      mockFile_put(`${dir}/${name.replace('mise-new', 'mise-old')}`, 'somebody else\'s aside');
      return { ok: true, value: { id: mockFile_put(`${dir}/${name}`, await blob.text()), path: `${dir}/${name}` } };
    });
    expect(await file_replace(NAME, new Blob(['new']), oldId)).toBe(false);
    expect(mockStore.moveAsked).toEqual([]);
    expect(content_at(NAME)).toBe('old');
    expect(content_at(leftover_find('mise-old'))).toBe('somebody else\'s aside');
  });
});
