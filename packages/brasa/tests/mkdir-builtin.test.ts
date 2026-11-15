/**
 * @file The `mkdir` builtin over a real filesystem held in memory.
 *
 * The session's filesystem is fond's dispatcher with the memory mount as
 * its store and a second memory mount as a projection (`/proc/tags`), so
 * mkdir is held to what a disk answers, not to a scripted mock.
 *
 * @module
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MemoryVfsProvider, VFSDispatcher, errorStack, type VFSProvider, type MemorySeed } from '@fnndsc/fond';
import type { CommandEnvelope } from '@fnndsc/menu';

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', URL: 'x', folder: '/home/chris' })),
}));
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: jest.fn(async () => '/home/chris') },
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));

const SEED: MemorySeed = { '/home/chris/a.txt': 'alpha', '/home/chris/here': null };
const state: { dispatcher: VFSDispatcher; store: MemoryVfsProvider } = (() => {
  const store: MemoryVfsProvider = new MemoryVfsProvider('', SEED);
  return { store, dispatcher: new VFSDispatcher(store) };
})();
const mockInvalidate = jest.fn();
/** Listings the session keeps, by folder. */
const kept: Map<string, Array<{ name: string }>> = new Map();
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => state.dispatcher,
  listingCache_get: () => ({
    cache_invalidate: mockInvalidate,
    cache_get: (path: string) => (kept.has(path) ? { data: kept.get(path), fresh: true } : null),
  }),
}));

const { builtin_mkdir, mkdirCommand } = await import('../src/builtins/fs/mkdir.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

/** What an `mkdir` line parses to: its paths and `-p`, or the refusal. */
async function mkdirLine_parse(line: string): Promise<{ paths: unknown; parents: unknown } | string> {
  const parsed = await commandLine_parse(mkdirCommand, shellWords_tokenize(line));
  return parsed.ok ? { paths: parsed.args.operands['paths'], parents: parsed.args.options['parents'] } : parsed.refusal;
}

/**
 * A fresh session filesystem.
 *
 * @param oneStep - Whether the store makes parents in one step (`mkdirTree`), as CUBE does.
 */
function filesystem_reset(oneStep: boolean = true): void {
  const store: MemoryVfsProvider = new MemoryVfsProvider('', SEED);
  if (!oneStep) (store as Partial<VFSProvider>).mkdirTree = undefined;
  const dispatcher: VFSDispatcher = new VFSDispatcher(store);
  dispatcher.provider_register(new MemoryVfsProvider('/proc/tags', { '/proc/tags/qc': null }));
  state.store = store;
  state.dispatcher = dispatcher;
}

/** What a folder lists, as `name:type`. */
async function itemNames_list(folder: string): Promise<string[]> {
  const listed = await state.dispatcher.list(folder);
  return listed.ok ? listed.value.map((item) => `${item.name}:${item.type}`).sort() : [];
}

beforeEach(() => {
  jest.clearAllMocks();
  kept.clear();
  errorStack.stack_clear();
  filesystem_reset();
});

describe('mkdir', () => {
  it('refuses a line with no arguments', async () => {
    const envelope: CommandEnvelope = await builtin_mkdir([]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('mkdir: missing operand <paths>');
  });

  it('makes a folder and invalidates its parent\'s listing', async () => {
    const envelope: CommandEnvelope = await builtin_mkdir(['newdir']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('/home/chris/newdir');
    expect(envelope.model?.kind).toBe('fs.mkdir');
    expect(await itemNames_list('/home/chris')).toContain('newdir:dir');
    expect(mockInvalidate).toHaveBeenCalledWith('/home/chris');
  });

  it('with -p, forgets every listing above the folder up to the first that already held its child', async () => {
    kept.set('/home', [{ name: 'chris' }]);
    kept.set('/home/chris', [{ name: 'here' }]);                  // listed before x was made
    const envelope: CommandEnvelope = await builtin_mkdir(['-p', 'x/a/b']);
    expect(envelope.status).toBe('ok');
    expect(mockInvalidate.mock.calls.map((c) => c[0])).toEqual(['/home/chris/x/a', '/home/chris/x', '/home/chris']);
  });

  it('refuses an option it does not have by name, making nothing', async () => {
    const envelope: CommandEnvelope = await builtin_mkdir(['-v', 'x']);
    expect(envelope.renderedErr).toContain("mkdir: invalid option -- 'v'");
    expect((await builtin_mkdir(['--mode=700', 'x'])).renderedErr).toContain("mkdir: unrecognized option '--mode'");
    expect(await itemNames_list('/home/chris')).not.toContain('x:dir');
  });

  it('never takes -p for a folder name', async () => {
    expect(await mkdirLine_parse('-p a/b')).toEqual({ paths: ['a/b'], parents: true });
    expect(await mkdirLine_parse('--parents a')).toEqual({ paths: ['a'], parents: true });
    expect(await mkdirLine_parse('-- -p')).toEqual({ paths: ['-p'], parents: false });
  });

  it('mkdir -p a/b/c makes the three folders and nothing named after an option word', async () => {
    for (const line of [['-p', 'a/b/c'], ['--parents', 'a/b/c'], ['a/b/c', '-p']]) {
      filesystem_reset();
      const envelope: CommandEnvelope = await builtin_mkdir(line);
      expect(envelope.status).toBe('ok');
      expect(await itemNames_list('/home/chris/a/b')).toEqual(['c:dir']);
      expect((await itemNames_list('/home/chris')).filter((name: string): boolean => name.startsWith('-'))).toEqual([]);
    }
    filesystem_reset();
    expect((await builtin_mkdir(['-px', 'a'])).renderedErr).toContain("mkdir: invalid option -- 'x'");
    expect((await builtin_mkdir(['--parent', 'a'])).status).toBe('error');
    expect((await itemNames_list('/home/chris')).filter((name: string): boolean => name === 'a:dir' || name.startsWith('-'))).toEqual([]);
  });

  it('mkdir -- -p is the one way to make a folder named -p', async () => {
    const envelope: CommandEnvelope = await builtin_mkdir(['--', '-p']);
    expect(envelope.status).toBe('ok');
    expect(await itemNames_list('/home/chris')).toContain('-p:dir');
    expect(await itemNames_list('/home/chris/-p')).toEqual([]);
  });

  it('without -p, a missing parent is No such file or directory', async () => {
    const envelope: CommandEnvelope = await builtin_mkdir(['a/b']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("mkdir: cannot create directory 'a/b': No such file or directory");
  });

  it.each([[true], [false]])('with -p, missing parents are made along the way (one step: %s)', async (oneStep: boolean) => {
    filesystem_reset(oneStep);
    const envelope: CommandEnvelope = await builtin_mkdir(['-p', 'a/b/c']);
    expect(envelope.status).toBe('ok');
    expect(await itemNames_list('/home/chris/a/b')).toEqual(['c:dir']);
  });

  it('without -p, an existing folder is File exists; with -p it is done', async () => {
    const plain: CommandEnvelope = await builtin_mkdir(['here']);
    expect(plain.status).toBe('error');
    expect(plain.renderedErr).toContain("mkdir: cannot create directory 'here': File exists");
    const parents: CommandEnvelope = await builtin_mkdir(['-p', 'here']);
    expect(parents.status).toBe('ok');
    expect(parents.rendered).toBe('');
  });

  it.each([[true], [false]])('makes no folder over a file, nor beneath one, -p or not (one step: %s)', async (oneStep: boolean) => {
    filesystem_reset(oneStep);
    for (const args of [['a.txt'], ['-p', 'a.txt']]) {
      const over: CommandEnvelope = await builtin_mkdir(args);
      expect(over.status).toBe('error');
      expect(over.renderedErr).toContain("mkdir: cannot create directory 'a.txt': File exists");
    }
    for (const args of [['a.txt/sub'], ['-p', 'a.txt/sub/deeper']]) {
      const beneath: CommandEnvelope = await builtin_mkdir(args);
      expect(beneath.status).toBe('error');
      expect(beneath.renderedErr).toContain(`mkdir: cannot create directory '${args[args.length - 1]}': Not a directory`);
    }
    expect(await itemNames_list('/home/chris')).toContain('a.txt:file');
    expect(await itemNames_list('/home/chris')).not.toContain('a.txt:dir');
  });

  it('says each path\'s refusal without abandoning the rest', async () => {
    const envelope: CommandEnvelope = await builtin_mkdir(['a.txt', 'b']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('File exists');
    expect(await itemNames_list('/home/chris')).toContain('b:dir');
  });
});

describe('mkdir inside a projection (/proc/tags)', () => {
  it('makes a folder through the projection, never the store', async () => {
    const envelope: CommandEnvelope = await builtin_mkdir(['/proc/tags/new']);
    expect(envelope.status).toBe('ok');
    expect(await itemNames_list('/proc/tags')).toContain('new:dir');
    expect(await itemNames_list('/')).not.toContain('proc:dir');
  });

  it("says the projection's refusal in mkdir's words, and takes an existing folder as done under -p", async () => {
    const refused: CommandEnvelope = await builtin_mkdir(['/proc/tags/qc']);
    expect(refused.renderedErr).toContain("mkdir: cannot create directory '/proc/tags/qc': File exists");
    const existing: CommandEnvelope = await builtin_mkdir(['-p', '/proc/tags/qc']);
    expect(existing.status).toBe('ok');
  });
});
