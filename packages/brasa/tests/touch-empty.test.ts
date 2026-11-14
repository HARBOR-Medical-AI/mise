/**
 * @file An empty value is a value: `--flag ''` carries the empty word, and
 * `touch --withContents '' f` (or `--withContents= f`) writes an empty file
 * rather than touching the empty word as a path.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', folder: '/home/chris' })),
}));
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  errorStack: { stack_pop: jest.fn(() => undefined), stack_search: () => [] },
  listCache_get: jest.fn(() => ({ cache_invalidate: jest.fn() })),
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: jest.fn(async () => '/home/chris') } }));
// touch writes through the session's filesystem; its writes are recorded here.
// The /proc mount stands for no store folder, so the store-path resolver leaves its paths as they are.
const mockWrite = jest.fn(async (_path: string, _content: string) => ({ ok: true as const, value: true as const }));
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({ path_isVirtual: (p: string): boolean => p.startsWith('/proc'), provider_get: () => ({ prefix: '/proc' }), write: mockWrite }),
  listingCache_get: () => ({ cache_invalidate: jest.fn() }),
}));

const { builtin_touch } = await import('../src/builtins/fs/touch.js');
const { commandArgs_process } = await import('../src/builtins/utils.js');

beforeEach((): void => { mockWrite.mockClear(); });

describe('an empty value', () => {
  it('is carried by a long flag, never dropped into the positionals', () => {
    expect(commandArgs_process(['--withContents', '', '/f'])).toEqual({ _: ['/f'], withContents: '' });
    expect(commandArgs_process(['--withContents=', '/f'])).toEqual({ _: ['/f'], withContents: '' });
  });

  it("writes an empty file: touch --withContents '' f", async () => {
    const env = await builtin_touch(['--withContents', '', '/proc/jobs/feed_12/note']);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledWith('/proc/jobs/feed_12/note', '');
    expect(env.status).toBe('ok');
  });

  it('takes a text beginning with a dash in the = form', async () => {
    await builtin_touch(['--withContents=- item one\n- item two', '/home/chris/list.yaml']);
    expect(mockWrite).toHaveBeenCalledWith('/home/chris/list.yaml', '- item one\n- item two');
  });
});
