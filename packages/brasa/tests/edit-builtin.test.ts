import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockVfsRead = jest.fn(async (_p: string): Promise<{ ok: boolean; value?: string; errno?: string }> => ({ ok: true, value: 'the note' }));
const mockVfsWrite = jest.fn(async (_p: string, _c: string) => ({ ok: true as const, value: true as const }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', folder: '/home/chris' })),
  vfsDispatcher: {
    path_isVirtual: (p: string): boolean => p.startsWith('/proc/'),
    read: mockVfsRead,
    write: mockVfsWrite,
  },
}));
const mockStackPop = jest.fn(() => undefined as { message: string } | undefined);
const mockInvalidate = jest.fn();
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  errorStack: { stack_pop: mockStackPop, stack_search: () => [] },
  listCache_get: jest.fn(() => ({ cache_invalidate: mockInvalidate })),
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: jest.fn(async () => '/home/chris') } }));

const mockCat = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({ files_cat: mockCat }));
const mockReplace = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/fs/edit.js', () => ({ file_replaceContent: mockReplace }));

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = () => ({ ok: false as const });

const { builtin_edit } = await import('../src/builtins/fs/edit.js');
const { surface_set } = await import('../src/core/surface.js');
import type { Surface, SurfaceCapabilities, LocalEditRequest, LocalEditResult } from '../src/core/surface.js';

// The surface's editor is a mock the tests drive.
const mockLocalEdit = jest.fn(async (_r: LocalEditRequest): Promise<LocalEditResult> => ({ content: '', changed: false }));

/** Installs a surface with the given capabilities and the mock editor. */
function surface_install(capabilities: SurfaceCapabilities): void {
  const surface: Surface = {
    capabilities,
    prompt: async (): Promise<string> => '',
    pipeSegment: async (_c: string, i: Buffer): Promise<Buffer> => i,
    localEdit: mockLocalEdit,
  };
  surface_set(surface);
}

let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockLocalEdit.mockResolvedValue({ content: '', changed: false });
  // The CLI host can edit locally; install a surface that says so.
  surface_install({ hiddenInput: true, localEdit: true, tty: true, pipeSegments: true });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('builtin_edit', () => {
  it('reports usage with no file', async () => {
    const env = await builtin_edit([]);
    expect(env.renderedErr).toContain('edit: missing operand <file>');
    expect(process.exitCode).toBe(1);
  });

  it('fails clearly when the surface cannot edit locally', async () => {
    surface_install({ hiddenInput: false, localEdit: false, tty: false, pipeSegments: false });
    const env = await builtin_edit(['notes.txt']);
    expect(env.renderedErr).toContain('cannot open a local editor');
    expect(process.exitCode).toBe(1);
    expect(mockCat).not.toHaveBeenCalled();
  });

  it('refuses to edit a binary file', async () => {
    const env = await builtin_edit(['image.png']);
    expect(env.renderedErr).toContain('binary file');
    expect(process.exitCode).toBe(1);
  });

  it('reports a read failure', async () => {
    mockCat.mockResolvedValue(err());
    mockStackPop.mockReturnValue({ message: 'no such file' });
    const env = await builtin_edit(['notes.txt']);
    expect(env.renderedErr).toContain('no such file');
    expect(process.exitCode).toBe(1);
  });

  it('hands the file content to the surface editor', async () => {
    mockCat.mockResolvedValue(ok('original'));
    mockLocalEdit.mockResolvedValue({ content: 'original', changed: false });
    await builtin_edit(['notes.txt']);
    expect(mockLocalEdit).toHaveBeenCalledWith(expect.objectContaining({ content: 'original' }));
  });

  it('does nothing when the content is unchanged', async () => {
    mockCat.mockResolvedValue(ok('original'));
    mockLocalEdit.mockResolvedValue({ content: 'original', changed: false });
    const env = await builtin_edit(['notes.txt']);
    expect(env.rendered).toContain('no changes');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('names the file to the editor, and saves nothing when a pane took it', async () => {
    mockCat.mockResolvedValue(ok('original'));
    mockLocalEdit.mockResolvedValue({ content: 'original', changed: false, opened: true });
    const env = await builtin_edit(['notes.txt']);
    expect(mockLocalEdit).toHaveBeenCalledWith({ content: 'original', extension: '.txt', path: '/home/chris/notes.txt' });
    expect(env.rendered).toContain('(opened in the editor)');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('reports an editor failure', async () => {
    mockCat.mockResolvedValue(ok('original'));
    mockLocalEdit.mockRejectedValue(new Error("failed to launch 'vi'"));
    const env = await builtin_edit(['notes.txt']);
    expect(env.renderedErr).toContain('failed to launch');
    expect(process.exitCode).toBe(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('re-uploads edited content and invalidates the cache', async () => {
    mockCat.mockResolvedValue(ok('original'));
    mockLocalEdit.mockResolvedValue({ content: 'EDITED CONTENT', changed: true });
    mockReplace.mockResolvedValue({ success: true });
    const env = await builtin_edit(['notes.txt']);
    expect(mockReplace).toHaveBeenCalled();
    expect(mockInvalidate).toHaveBeenCalled();
    expect(env.rendered).toContain('Saved');
  });

  it('preserves the edited content when the save fails', async () => {
    mockCat.mockResolvedValue(ok('original'));
    mockLocalEdit.mockResolvedValue({ content: 'EDITED CONTENT', changed: true });
    mockReplace.mockResolvedValue({ success: false, error: 'server rejected' });
    const env = await builtin_edit(['notes.txt']);
    expect(env.renderedErr).toContain('Save failed');
    expect(env.renderedErr).toContain('preserved at');
    expect(process.exitCode).toBe(1);
    // The preserved copy is the edit itself, 0600, in a folder of its own that only this account can open.
    const kept: string = /preserved at: (\S+)/.exec(env.renderedErr ?? '')?.[1] ?? '';
    const { readFileSync, statSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    expect(readFileSync(kept, 'utf8')).toBe('EDITED CONTENT');
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(kept)).mode & 0o777).toBe(0o700);
  });

  it('removes its private copy once a save goes through, and keeps none at a predictable name', async () => {
    mockCat.mockResolvedValue(ok('original'));
    mockLocalEdit.mockResolvedValue({ content: 'EDITED CONTENT', changed: true });
    let seen: string = '';
    mockReplace.mockImplementation(async (_target: unknown, local: unknown) => { seen = String(local); return { success: true }; });
    await builtin_edit(['notes.txt']);
    const { existsSync } = await import('node:fs');
    const { dirname, basename } = await import('node:path');
    const { tmpdir } = await import('node:os');
    expect(dirname(dirname(seen))).toBe(tmpdir());
    expect(basename(dirname(seen))).toMatch(/^chell-edit-.{6}$/);
    expect(existsSync(dirname(seen))).toBe(false);
  });
});

describe('builtin_edit on a projected file', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    surface_install({ localEdit: true } as SurfaceCapabilities);
    mockStackPop.mockReset().mockReturnValue(undefined);
    mockVfsRead.mockResolvedValue({ ok: true, value: 'the note' });
    mockVfsWrite.mockResolvedValue({ ok: true as const, value: true as const });
  });

  it("reads a feed's note through the projection, edits it, writes it back there", async () => {
    mockLocalEdit.mockResolvedValueOnce({ content: 'edited', changed: true });
    const env = await builtin_edit(['/proc/jobs/feed_12/note']);
    expect(mockVfsRead).toHaveBeenCalledWith('/proc/jobs/feed_12/note');
    expect(mockLocalEdit).toHaveBeenCalledWith({ content: 'the note', extension: '.txt', path: '/proc/jobs/feed_12/note' });
    expect(mockVfsWrite).toHaveBeenCalledWith('/proc/jobs/feed_12/note', 'edited');
    expect(env.status).toBe('ok');
    expect(mockCat).not.toHaveBeenCalled();
  });

  it('writes nothing back when a pane opened the note', async () => {
    mockLocalEdit.mockResolvedValueOnce({ content: 'the note', changed: false, opened: true });
    const env = await builtin_edit(['/proc/jobs/feed_12/note']);
    expect(env.rendered).toContain('(opened in the editor)');
    expect(mockVfsWrite).not.toHaveBeenCalled();
  });

  it('writes nothing when the editor changed nothing', async () => {
    mockLocalEdit.mockResolvedValueOnce({ content: 'the note', changed: false });
    const env = await builtin_edit(['/proc/jobs/feed_12/note']);
    expect(env.rendered).toContain('(no changes)');
    expect(mockVfsWrite).not.toHaveBeenCalled();
  });

  it("says the projection's refusal, in its words, when it will not take the write or the read", async () => {
    mockLocalEdit.mockResolvedValueOnce({ content: 'x', changed: true });
    mockVfsWrite.mockResolvedValueOnce({ ok: false as const, errno: 'EIO' as const });
    mockStackPop.mockReturnValueOnce({ message: '/proc/jobs/feed_12/title: Read-only file system' });
    const refused = await builtin_edit(['/proc/jobs/feed_12/title']);
    expect(refused.renderedErr).toContain('Read-only file system');
    mockVfsRead.mockResolvedValueOnce({ ok: false });
    const unread = await builtin_edit(['/proc/jobs/feed_12/note']);
    expect(unread.renderedErr).toContain('could not read');
    mockLocalEdit.mockRejectedValueOnce(new Error('editor crashed'));
    const crashed = await builtin_edit(['/proc/jobs/feed_12/note']);
    expect(crashed.renderedErr).toContain('editor crashed');
  });
});
