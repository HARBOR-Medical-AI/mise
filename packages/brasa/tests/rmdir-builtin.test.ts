/**
 * @file rmdir over a real filesystem held in memory: an empty folder goes,
 * one that holds anything or is not there is refused by name, and a
 * projection (/proc/tags) removes or refuses its own.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MemoryVfsProvider, VFSDispatcher, errorStack, vfs_fail, type VFSProvider } from '@fnndsc/fond';

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', URL: 'x', folder: '/home/chris' })),
}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: jest.fn(async () => '/home/chris') } }));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
const state: { dispatcher: VFSDispatcher } = { dispatcher: new VFSDispatcher() };
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => state.dispatcher,
  listingCache_get: () => ({ cache_invalidate: jest.fn() }),
}));

const { builtin_rmdir, rmdirCommand } = await import('../src/builtins/fs/rmdir.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

/** What an `rmdir` line parses to: its paths, or the refusal. */
async function rmdirLine_parse(line: string): Promise<{ paths: unknown } | string> {
  const parsed = await commandLine_parse(rmdirCommand, shellWords_tokenize(line));
  return parsed.ok ? { paths: parsed.args.operands['paths'] } : parsed.refusal;
}

/** What a folder lists, by name. */
async function itemNames_list(folder: string): Promise<string[]> {
  const listed = await state.dispatcher.list(folder);
  return listed.ok ? listed.value.map((item) => item.name).sort() : [];
}

beforeEach(() => {
  errorStack.stack_clear();
  process.exitCode = 0;
  state.dispatcher = new VFSDispatcher(new MemoryVfsProvider('', { '/home/chris/scratch': null, '/home/chris/full/f': 'x', '/home/chris/a.txt': 'a' }));
  const tags: MemoryVfsProvider = new MemoryVfsProvider('/proc/tags', { '/proc/tags/old': null, '/proc/tags/urgent': null });
  const rmdir = tags.rmdir.bind(tags);
  (tags as Partial<VFSProvider>).rmdir = async (where: string) =>
    where.endsWith('/urgent') ? vfs_fail('ENOTEMPTY', 'urgent: Directory not empty (2 feeds wear it)') : rmdir(where);
  state.dispatcher.provider_register(tags);
});

describe('rmdir', () => {
  it('removes an empty folder, silently', async () => {
    const env = await builtin_rmdir(['scratch']);
    expect(env.status).toBe('ok');
    expect(env.rendered).toBe('');
    expect(await itemNames_list('/home/chris')).not.toContain('scratch');
  });

  it('refuses a folder that holds anything, one that is not there, and a file, by name', async () => {
    expect((await builtin_rmdir(['full'])).renderedErr).toContain("rmdir: failed to remove 'full': Directory not empty");
    expect((await builtin_rmdir(['gone'])).renderedErr).toContain("rmdir: failed to remove 'gone': No such file or directory");
    expect((await builtin_rmdir(['a.txt'])).renderedErr).toContain("rmdir: failed to remove 'a.txt': Not a directory");
    expect(await itemNames_list('/home/chris')).toEqual(['a.txt', 'full', 'scratch']);
    expect(process.exitCode).toBe(1);
  });

  it("deletes a tag through the projection, and says the projection's refusal in rmdir's words", async () => {
    expect((await builtin_rmdir(['/proc/tags/old'])).status).toBe('ok');
    expect(await itemNames_list('/proc/tags')).toEqual(['urgent']);
    expect((await builtin_rmdir(['/proc/tags/urgent'])).renderedErr).toContain("rmdir: failed to remove '/proc/tags/urgent': Directory not empty (2 feeds wear it)");
  });

  it('takes paths only, refusing any option by name', async () => {
    expect(await rmdirLine_parse('-p x')).toMatch(/^rmdir: invalid option -- 'p'; usage: /);
    expect(await rmdirLine_parse('--parents')).toMatch(/^rmdir: unrecognized option '--parents'; usage: /);
    expect(await rmdirLine_parse('-- -odd')).toEqual({ paths: ['-odd'] });
  });

  it('refuses a line with nothing to remove', async () => {
    expect((await builtin_rmdir([])).renderedErr).toContain('rmdir: missing operand <paths>');
  });
});
