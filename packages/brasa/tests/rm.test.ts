/**
 * @file Unit tests for the extracted `rm` helpers.
 *
 * Covers rm's line as its declaration parses it and the multi-target
 * summary formatter. Heavy IO/cross-package deps are mocked.
 *
 * @module
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MemoryVfsProvider, VFSDispatcher, errorStack, vfs_fail, type VFSProvider } from '@fnndsc/fond';

const state: { dispatcher: VFSDispatcher } = { dispatcher: new VFSDispatcher() };
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => state.dispatcher,
  listingCache_get: () => ({ cache_invalidate: jest.fn(), cache_invalidateTree: jest.fn() }),
}));
const mockResolve = jest.fn(async (p: string): Promise<string> => (p.startsWith('/') ? p : `/home/me/${p}`));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: mockResolve, storePath_resolve: mockResolve }));
const mockConfirm = jest.fn(async (): Promise<boolean> => true);
jest.unstable_mockModule('../src/core/question.js', () => ({ repl_confirm: mockConfirm }));
const mockSinkWrite = jest.fn();
jest.unstable_mockModule('../src/core/sink.js', () => ({
  sink_get: (): unknown => ({ data_write: mockSinkWrite, err_write: mockSinkWrite }),
}));

const { rmCommand, rmSummary_format, rm_run, builtin_rm } = await import('../src/builtins/fs/rm.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

/** What an `rm` line parses to: its switches and paths, or the refusal. */
async function rmLine_parse(line: string): Promise<Record<string, unknown> | string> {
  const parsed = await commandLine_parse(rmCommand, shellWords_tokenize(line));
  return parsed.ok ? { ...parsed.args.options, paths: parsed.args.operands['paths'] } : parsed.refusal;
}

/** The switches of an `rm` line with nothing set. */
const NONE: Record<string, boolean> = { recursive: false, recursiveAlias: false, force: false, interactive: false, once: false };

/** What /home/me lists, by name. */
async function home_names(folder: string = '/home/me'): Promise<string[]> {
  const listed = await state.dispatcher.list(folder);
  return listed.ok ? listed.value.map((item) => item.name).sort() : [];
}

/** A fresh session filesystem; `mount` adjusts the store first. */
function filesystem_reset(mount?: (store: MemoryVfsProvider) => void): void {
  const store: MemoryVfsProvider = new MemoryVfsProvider('', {
    '/home/me/a': 'a', '/home/me/b': 'b', '/home/me/c': 'c', '/home/me/d': 'd', '/home/me/only.txt': 'o',
    '/home/me/docs/inner/deep.txt': 'x', '/home/me/empty': null,
  });
  if (mount) mount(store);
  state.dispatcher = new VFSDispatcher(store);
  const tags: MemoryVfsProvider = new MemoryVfsProvider('/proc/tags', { '/proc/tags/qc/feed_1': null });
  (tags as Partial<VFSProvider>).rm = async () => vfs_fail('EPERM', 'Operation not permitted (setfattr -x tag -v qc feed_1 untags the feed)');
  state.dispatcher.provider_register(tags);
}

beforeEach(() => {
  errorStack.stack_clear();
  mockSinkWrite.mockClear();
  filesystem_reset();
});

describe("rm's line", () => {
  it('parses combined short flags and paths', async () => {
    expect(await rmLine_parse('-rf a b')).toEqual({ ...NONE, recursive: true, force: true, paths: ['a', 'b'] });
  });
  it('handles fully-combined flags in any order', async () => {
    expect(await rmLine_parse('-rfi x')).toEqual({ ...NONE, recursive: true, force: true, interactive: true, paths: ['x'] });
    expect(await rmLine_parse('-iR x')).toEqual({ ...NONE, recursiveAlias: true, interactive: true, paths: ['x'] });
  });
  it('treats everything after -- as a path', async () => {
    expect(await rmLine_parse('-- -weird-name -r')).toEqual({ ...NONE, paths: ['-weird-name', '-r'] });
  });
  it('refuses an unknown option by name', async () => {
    expect(await rmLine_parse('-x foo')).toMatch(/^rm: invalid option -- 'x'; usage: /);
    expect(await rmLine_parse('--verbose foo')).toMatch(/^rm: unrecognized option '--verbose'; usage: /);
  });
  it('reads long options whole, never letter by letter', async () => {
    expect(await rmLine_parse('--force a')).toEqual({ ...NONE, force: true, paths: ['a'] });
    expect(await rmLine_parse('--recursive a')).toEqual({ ...NONE, recursive: true, paths: ['a'] });
  });
  it('refuses a line with no path', async () => {
    expect(await rmLine_parse('-rf')).toMatch(/^rm: missing operand <paths>; usage: /);
  });
  it('builtin_rm removes nothing when an option is refused', async () => {
    const envelope = await builtin_rm(['-v', 'a']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("rm: invalid option -- 'v'");
    expect(await home_names()).toContain('a');
  });

  it('reads -I as one question for the whole list, distinct from -i', async () => {
    expect(await rmLine_parse('-I a b')).toEqual({ ...NONE, once: true, paths: ['a', 'b'] });
    expect(await rmLine_parse('-rI a')).toEqual({ ...NONE, recursive: true, once: true, paths: ['a'] });
  });
});

describe('rm removes as a disk does', () => {
  it('removes a file, says so, and refuses a folder without -r', async () => {
    const one = await rm_run({ recursive: false, force: false, interactive: false, once: false, paths: ['a'] });
    expect(one.rendered).toContain('Removed file: /home/me/a');
    const folder = await rm_run({ recursive: false, force: false, interactive: false, once: false, paths: ['docs'] });
    expect(folder.renderedErr).toContain("rm: cannot remove 'docs': Is a directory");
    expect(await home_names()).toContain('docs');
  });

  it('removes a folder with all it holds under -r, walked where the mount has no rmTree', async () => {
    filesystem_reset((store) => { (store as Partial<VFSProvider>).rmTree = undefined; });
    const envelope = await rm_run({ recursive: true, force: false, interactive: false, once: false, paths: ['docs'] });
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('Removed dir: /home/me/docs');
    expect(await home_names()).not.toContain('docs');
  });

  it('says nothing there as Linux does, and passes a mount\'s refusal on with its words', async () => {
    const missing = await rm_run({ recursive: false, force: false, interactive: false, once: false, paths: ['gone'] });
    expect(missing.renderedErr).toContain("rm: cannot remove 'gone': No such file or directory");
    const tagged = await rm_run({ recursive: false, force: false, interactive: false, once: false, paths: ['/proc/tags/qc/feed_1'] });
    expect(tagged.renderedErr).toContain("rm: cannot remove '/proc/tags/qc/feed_1': Operation not permitted (setfattr -x tag -v qc feed_1 untags the feed)");
  });

  it('summarises several operands', async () => {
    const envelope = await rm_run({ recursive: false, force: false, interactive: false, once: false, paths: ['a', 'b', 'gone'] });
    expect(envelope.rendered).toContain("removed 'a'");
    expect(envelope.rendered).toContain('Removed 2 items, failed 1');
    expect(envelope.status).toBe('error');
  });
});

describe('rm -f on a missing operand', () => {
  it('says nothing and succeeds, as on Linux', async () => {
    const envelope = await rm_run({ recursive: false, force: true, interactive: false, once: false, paths: ['gone'] });
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toBe('');
  });
});

describe('rmSummary_format', () => {
  it('returns null when nothing happened', () => {
    expect(rmSummary_format(0, 0)).toBeNull();
  });
  it('reports all-success (with singular/plural)', () => {
    expect(rmSummary_format(3, 0)).toContain('Successfully removed 3 items');
    expect(rmSummary_format(1, 0)).toContain('Successfully removed 1 item');
  });
  it('reports mixed success/failure', () => {
    expect(rmSummary_format(2, 1)).toContain('Removed 2 items, failed 1');
  });
  it('reports all-failure', () => {
    expect(rmSummary_format(0, 2)).toContain('Failed to remove 2 items');
  });
});

describe('rm -I', () => {
  beforeEach(() => {
    mockConfirm.mockClear();
  });

  it('asks once for the whole list, naming how many', async () => {
    mockConfirm.mockResolvedValue(true);
    await rm_run({ recursive: false, force: false, interactive: false, once: true, paths: ['a', 'b', 'c'] });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith('rm: remove 3 items? (y/n): ');
    expect(await home_names()).toEqual(['d', 'docs', 'empty', 'only.txt']);
  });

  it('removes nothing at all when the one question is answered no', async () => {
    mockConfirm.mockResolvedValue(false);
    const envelope = await rm_run({ recursive: false, force: false, interactive: false, once: true, paths: ['a', 'b'] });
    expect(await home_names()).toContain('a');
    expect(envelope.rendered).toContain('nothing removed (2 kept)');
  });

  it('names the one thing when the list is one long', async () => {
    mockConfirm.mockResolvedValue(true);
    await rm_run({ recursive: false, force: false, interactive: false, once: true, paths: ['only.txt'] });
    expect(mockConfirm).toHaveBeenCalledWith("rm: remove 'only.txt'? (y/n): ");
  });
});

describe('a question that is never answered', () => {
  beforeEach(() => {
    mockConfirm.mockClear();
    mockSinkWrite.mockClear();
  });

  /** Everything the command wrote to the surface, as one string. */
  function said(): string {
    return mockSinkWrite.mock.calls.map((call: unknown[]): string => String(call[0])).join('');
  }

  it('keeps everything under -I, and says why, rather than reporting a failure', async () => {
    mockConfirm.mockRejectedValue(new Error('the operator abandoned the question'));
    const envelope = await rm_run({ recursive: false, force: false, interactive: false, once: true, paths: ['a', 'b'] });
    expect(await home_names()).toContain('b');
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('nothing removed (2 kept)');
    // The reason travels: a surface that has lost its voice must not read
    // as an operator who declined.
    expect(envelope.rendered).toContain('the operator abandoned the question');
  });

  it('skips the file under -i, the way a no does, and does not report a failure', async () => {
    mockConfirm.mockRejectedValue(new Error('the operator abandoned the question'));
    const envelope = await rm_run({ recursive: false, force: false, interactive: true, once: false, paths: ['only.txt'] });
    expect(await home_names()).toContain('only.txt');
    // Not `rm: cannot remove ...`, which is what an unguarded await made of
    // an abandoned question: an error, over a file nothing had touched.
    expect(said()).toContain("skipped 'only.txt': the operator abandoned the question");
    expect(said()).not.toContain('cannot remove');
    expect(envelope.status).toBe('ok');
    expect(envelope.model).toEqual({ kind: 'fs.rm', data: [{ path: 'only.txt', removed: false, skipped: true }] });
  });

  it('stops asking about the rest, and says how many it left alone', async () => {
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockRejectedValue(new Error('the operator abandoned the question'));

    const envelope = await rm_run({ recursive: false, force: false, interactive: true, once: false, paths: ['a', 'b', 'c', 'd'] });

    // One removed, one abandoned, and the two behind it never put to an
    // operator who had already walked away.
    expect(await home_names()).toEqual(['b', 'c', 'd', 'docs', 'empty', 'only.txt']);
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(said()).toContain('2 more not asked about, and kept');
    expect(envelope.model).toEqual({
      kind: 'fs.rm',
      data: [
        { path: 'a', removed: true, skipped: false },
        { path: 'b', removed: false, skipped: true },
        { path: 'c', removed: false, skipped: true },
        { path: 'd', removed: false, skipped: true },
      ],
    });
  });

  it('still asks about every file when the operator keeps answering', async () => {
    mockConfirm.mockResolvedValue(false);
    const envelope = await rm_run({ recursive: false, force: false, interactive: true, once: false, paths: ['a', 'b', 'c'] });
    expect(mockConfirm).toHaveBeenCalledTimes(3);
    expect(said()).not.toContain('not asked about');
    expect(envelope.status).toBe('ok');
  });
});

describe('a question does not move what rm removes', () => {
  // While a question is open the session runs other commands; a `cd` among
  // them must not turn the answer into a removal somewhere else.
  const cwdMoves = (): void => {
    mockResolve.mockImplementation(async (p: string): Promise<string> => (p.startsWith('/') ? p : `/elsewhere/${p}`));
  };
  const cwdHome = (): void => {
    mockResolve.mockImplementation(async (p: string): Promise<string> => (p.startsWith('/') ? p : `/home/me/${p}`));
  };

  it('-I: every operand is fixed before the one question', async () => {
    filesystem_reset((store) => { store.write?.('/elsewhere/a', 'theirs'); });
    mockConfirm.mockImplementationOnce(async (): Promise<boolean> => { cwdMoves(); return true; });
    try {
      await rm_run({ recursive: false, force: false, interactive: false, once: true, paths: ['a', 'b'] });
    } finally {
      cwdHome();
    }
    expect(await home_names()).not.toContain('a');
    expect(await home_names()).not.toContain('b');
  });

  it('-i: the second operand was fixed before the first question', async () => {
    mockConfirm.mockImplementationOnce(async (): Promise<boolean> => { cwdMoves(); return true; }).mockImplementationOnce(async (): Promise<boolean> => true);
    try {
      await rm_run({ recursive: false, force: false, interactive: true, once: false, paths: ['c', 'd'] });
    } finally {
      cwdHome();
    }
    expect(await home_names()).not.toContain('c');
    expect(await home_names()).not.toContain('d');
  });
});

