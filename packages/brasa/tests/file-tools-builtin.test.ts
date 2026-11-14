/**
 * @file The `touch`, `mv` and `cp` builtins over a real filesystem held in memory.
 *
 * The session's filesystem is fond's dispatcher with the memory mount as
 * its store (parents made in one step, as CUBE makes them) and a second
 * memory mount as a projection (`/proc/tags`).
 *
 * @module
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MemoryVfsProvider, VFSDispatcher, errorStack, vfs_fail, type MemorySeed, type VFSProvider } from '@fnndsc/fond';
import type { CommandEnvelope } from '@fnndsc/menu';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', URL: 'x', folder: '/home/chris' })),
}));
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: jest.fn(async () => '/home/chris') },
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
const mockDestination = jest.fn<(request: Record<string, unknown>) => Promise<string>>(async () => '/home/chris/moved.txt');
jest.unstable_mockModule('../src/core/question.js', () => ({
  repl_questionPath: (message: string, where: unknown, commit?: string): Promise<string> => mockDestination({ message, where, commit }),
}));

const SEED: MemorySeed = { '/home/chris/a.txt': 'alpha', '/home/chris/b.txt': 'beta', '/home/chris/docs': null };
const state: { dispatcher: VFSDispatcher } = { dispatcher: new VFSDispatcher(new MemoryVfsProvider('', SEED)) };
const mockInvalidate = jest.fn();
const mockInvalidateTree = jest.fn();
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => state.dispatcher,
  listingCache_get: () => ({ cache_invalidate: mockInvalidate, cache_invalidateTree: mockInvalidateTree }),
}));

const { builtin_touch } = await import('../src/builtins/fs/touch.js');
const { builtin_mv } = await import('../src/builtins/fs/mv.js');
const { builtin_cp } = await import('../src/builtins/fs/cp.js');

/** A fresh session filesystem, with a /proc/tags projection that renames inside itself. */
function filesystem_reset(): MemoryVfsProvider {
  const store: MemoryVfsProvider = new MemoryVfsProvider('', SEED);
  const dispatcher: VFSDispatcher = new VFSDispatcher(store);
  const tags: MemoryVfsProvider = new MemoryVfsProvider('/proc/tags', { '/proc/tags/a': null });
  dispatcher.provider_register(tags);
  state.dispatcher = dispatcher;
  return store;
}

/** A file's text, or null. */
async function text_extract(where: string): Promise<string | null> {
  const read = await state.dispatcher.read(where);
  return read.ok ? read.value : null;
}

/** What a folder lists, as `name:type`. */
async function itemNames_list(folder: string): Promise<string[]> {
  const listed = await state.dispatcher.list(folder);
  return listed.ok ? listed.value.map((item) => `${item.name}:${item.type}`).sort() : [];
}

beforeEach(() => {
  jest.clearAllMocks();
  errorStack.stack_clear();
  filesystem_reset();
});

describe('touch', () => {
  it('refuses a line with no file argument, and an option it does not have', async () => {
    expect((await builtin_touch([])).renderedErr).toContain('touch: missing operand <paths>');
    expect((await builtin_touch(['-p', 'a'])).renderedErr).toContain("touch: invalid option -- 'p'");
  });

  it('makes a missing file empty and invalidates its parent\'s listing', async () => {
    const envelope: CommandEnvelope = await builtin_touch(['note.txt']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('Created file: /home/chris/note.txt');
    expect(envelope.model?.kind).toBe('fs.touch');
    expect(await text_extract('/home/chris/note.txt')).toBe('');
    expect(mockInvalidate).toHaveBeenCalledWith('/home/chris');
  });

  it('leaves a file already there as it is, its content kept', async () => {
    expect((await builtin_touch(['a.txt'])).status).toBe('ok');
    expect(await text_extract('/home/chris/a.txt')).toBe('alpha');
  });

  it('writes content whole into the first file only, replacing what was there', async () => {
    const envelope: CommandEnvelope = await builtin_touch(['a.txt', 'b.txt', '--withContents', 'hi']);
    expect(envelope.rendered).toContain('Wrote file: /home/chris/a.txt');
    expect(await text_extract('/home/chris/a.txt')).toBe('hi');
    expect(await text_extract('/home/chris/b.txt')).toBe('beta');
  });

  it('writes a local file\'s text, and says when that file is not there', async () => {
    const local: string = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'touch-')), 'from.txt');
    fs.writeFileSync(local, 'from disk');
    expect((await builtin_touch(['--withContentsFromFile', local, 'c.txt'])).status).toBe('ok');
    expect(await text_extract('/home/chris/c.txt')).toBe('from disk');
    const missing: CommandEnvelope = await builtin_touch(['--withContentsFromFile', `${local}.none`, 'd.txt']);
    expect(missing.renderedErr).toContain('Local file not found');
  });

  it('makes no folders: a missing parent is No such file or directory, as on a disk', async () => {
    const envelope: CommandEnvelope = await builtin_touch(['--withContents', 'x', 'new/deeper/f.txt']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('No such file or directory');
    expect(await itemNames_list('/home/chris')).not.toContain('new:dir');
  });

  it('writes no file where a folder is, nor beneath a file', async () => {
    const over: CommandEnvelope = await builtin_touch(['docs']);
    expect(over.status).toBe('error');
    expect(over.renderedErr).toContain('Failed to create file: /home/chris/docs');
    expect(over.renderedErr).toContain('Is a directory');
    const written: CommandEnvelope = await builtin_touch(['--withContents', 'x', 'docs']);
    expect(written.renderedErr).toContain('Is a directory');
    const beneath: CommandEnvelope = await builtin_touch(['a.txt/inner']);
    expect(beneath.status).toBe('error');
    expect(beneath.renderedErr).toContain('Not a directory');
    expect(await itemNames_list('/home/chris')).toContain('docs:dir');
    expect(await text_extract('/home/chris/a.txt')).toBe('alpha');
  });

  it('writes a projected file only with text', async () => {
    const bare: CommandEnvelope = await builtin_touch(['/proc/tags/a/note']);
    expect(bare.renderedErr).toContain('a projected file takes text (--withContents)');
  });
});

describe('mv', () => {
  it('reports usage with nothing given, and refuses an option it does not have', async () => {
    expect((await builtin_mv([])).renderedErr).toContain('mv: missing operand <paths>; usage: mv');
    expect((await builtin_mv(['--force', 'a', 'b'])).renderedErr).toContain("mv: unrecognized option '--force'");
  });

  it('asks where a lone source should go, and moves it there; moves nothing when that is abandoned', async () => {
    mockDestination.mockResolvedValueOnce('/home/chris/moved.txt');
    expect((await builtin_mv(['a.txt'])).status).toBe('ok');
    expect(await text_extract('/home/chris/moved.txt')).toBe('alpha');
    mockDestination.mockResolvedValueOnce('   ');
    const abandoned: CommandEnvelope = await builtin_mv(['b.txt']);
    expect(abandoned.renderedErr).toContain('nothing moved');
    expect(await text_extract('/home/chris/b.txt')).toBe('beta');
  });

  it('renames a file and invalidates source and destination', async () => {
    const envelope: CommandEnvelope = await builtin_mv(['a.txt', 'c.txt']);
    expect(envelope.status).toBe('ok');
    expect(envelope.model?.kind).toBe('fs.mv');
    expect(await text_extract('/home/chris/c.txt')).toBe('alpha');
    expect(await text_extract('/home/chris/a.txt')).toBeNull();
    expect(mockInvalidate).toHaveBeenCalledWith('/home/chris');
    expect(mockInvalidateTree).toHaveBeenCalledWith('/home/chris/c.txt');
  });

  it('moves into a folder the destination names, keeping the name; several sources summarised', async () => {
    const envelope: CommandEnvelope = await builtin_mv(['a.txt', 'b.txt', 'docs']);
    expect(envelope.rendered).toContain('Moved 2 file(s)');
    expect(await itemNames_list('/home/chris/docs')).toEqual(['a.txt:file', 'b.txt:file']);
  });

  it('says a missing source by name, and keeps a destination already there', async () => {
    const missing: CommandEnvelope = await builtin_mv(['none.txt', 'x.txt']);
    expect(missing.status).toBe('error');
    expect(missing.renderedErr).toContain('mv: Source not found: /home/chris/none.txt');
    const onto: CommandEnvelope = await builtin_mv(['a.txt', 'b.txt']);
    expect(onto.status).toBe('ok');
    // The memory mount replaces, as a disk does; CUBE refuses (its own test says so).
    expect(await text_extract('/home/chris/b.txt')).toBe('alpha');
  });

  it('says the mount\'s refusal once, never "mv: mv:"', async () => {
    const store: MemoryVfsProvider = filesystem_reset();
    (store as Partial<VFSProvider>).rename = async () => vfs_fail('EEXIST', 'Destination exists: /home/chris/b.txt — mise cannot overwrite a file; remove it first');
    const refused: CommandEnvelope = await builtin_mv(['a.txt', 'b.txt']);
    expect(refused.renderedErr).toContain('mv: Destination exists: /home/chris/b.txt');
    expect(refused.renderedErr).not.toContain('mv: mv:');
  });

  it('renames inside a projection, and refuses across one with the shell\'s words', async () => {
    expect((await builtin_mv(['/proc/tags/a', '/proc/tags/b'])).status).toBe('ok');
    expect(await itemNames_list('/proc/tags')).toEqual(['b:dir']);
    const across: CommandEnvelope = await builtin_mv(['/proc/tags/b', '/home/x']);
    expect(across.renderedErr).toContain("mv: cannot move '/proc/tags/b' to '/home/x': Invalid cross-device link");
    expect(across.renderedErr).not.toContain('mv: mv:');
  });
});

describe('cp', () => {
  it('reports usage with nothing given, and refuses an option it does not have', async () => {
    expect((await builtin_cp([])).renderedErr).toContain('cp: missing operand <paths>; usage: cp');
    expect((await builtin_cp(['-x', 'a', 'b'])).renderedErr).toContain("cp: invalid option -- 'x'");
  });

  it('asks where a lone source should go, and copies it there; copies nothing when that is abandoned', async () => {
    mockDestination.mockResolvedValueOnce('/home/chris/copy.txt');
    expect((await builtin_cp(['a.txt'])).status).toBe('ok');
    expect(await text_extract('/home/chris/copy.txt')).toBe('alpha');
    mockDestination.mockResolvedValueOnce('   ');
    const abandoned: CommandEnvelope = await builtin_cp(['b.txt']);
    expect(abandoned.renderedErr).toContain('nothing copied');
  });

  it('copies a file, the source kept, and invalidates the destination', async () => {
    const envelope: CommandEnvelope = await builtin_cp(['a.txt', 'c.txt']);
    expect(envelope.status).toBe('ok');
    expect(envelope.model?.kind).toBe('fs.cp');
    expect(await text_extract('/home/chris/c.txt')).toBe('alpha');
    expect(await text_extract('/home/chris/a.txt')).toBe('alpha');
    expect(mockInvalidateTree).toHaveBeenCalledWith('/home/chris/c.txt');
  });

  it('copies into a folder the destination names, keeping the name; several sources summarised', async () => {
    const envelope: CommandEnvelope = await builtin_cp(['a.txt', 'b.txt', 'docs']);
    expect(envelope.rendered).toContain('Copied 2 file(s)');
    expect(await itemNames_list('/home/chris/docs')).toEqual(['a.txt:file', 'b.txt:file']);
  });

  it('copies a folder only with -r (--recursive keeps the operand after it)', async () => {
    const plain: CommandEnvelope = await builtin_cp(['docs', 'docs2']);
    expect(plain.status).toBe('error');
    expect(plain.renderedErr).toContain("cp: cannot copy '/home/chris/docs' to '/home/chris/docs2': Is a directory");
    await builtin_touch(['docs/inner.txt']);
    expect((await builtin_cp(['--recursive', 'docs', 'docs2'])).status).toBe('ok');
    expect(await itemNames_list('/home/chris/docs2')).toEqual(['inner.txt:file']);
  });

  it('says the mount\'s refusal once, never "cp: cp:", and a missing source', async () => {
    const store: MemoryVfsProvider = filesystem_reset();
    (store as Partial<VFSProvider>).cp = async () => vfs_fail('EROFS', "cp: Copying from static VFS path '/bin/x' is not supported.");
    const refused: CommandEnvelope = await builtin_cp(['a.txt', 'z.txt']);
    expect(refused.renderedErr).toContain("cp: Copying from static VFS path '/bin/x' is not supported.");
    expect(refused.renderedErr).not.toContain('cp: cp:');
    filesystem_reset();
    const missing: CommandEnvelope = await builtin_cp(['none.txt', 'z.txt']);
    expect(missing.status).toBe('error');
    expect(missing.renderedErr).toContain('No such file or directory');
  });
});
