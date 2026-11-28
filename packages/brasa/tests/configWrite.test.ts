/**
 * @file Tests for `config write`: the durable layer's write path.
 *
 * The command decodes base64, stages a host temp file, and rides the same
 * upload (and replace-in-place fallback) the edit flow uses. What matters
 * here: the decoded bytes reach the upload, replacement engages only when
 * a fresh upload is refused, and refusals are honest.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const uploadPath = jest.fn<(local: string, remote: string) => Promise<boolean>>();
const replaceContent = jest.fn<(remote: string, local: string) => Promise<{ success: boolean }>>();

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  files_uploadPath: uploadPath,
}));
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _model?: unknown, renderedErr?: string) =>
    ({ status: 'error', rendered, renderedErr }),
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/edit.js', () => ({
  file_replaceContent: replaceContent,
}));
const pathMock_resolve = async (raw: string): Promise<string> => (raw.startsWith('/') ? raw : `/home/tester/${raw.replace(/^~\//, '')}`);
jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  path_resolve: pathMock_resolve,
  storePath_resolve: pathMock_resolve,
}));

const { builtin_config } = await import('../src/builtins/fs/configWrite.js');

const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('config write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = 0;
    uploadPath.mockResolvedValue(true);
    replaceContent.mockResolvedValue({ success: true });
  });

  it('uploads the decoded document to the resolved CFS path', async () => {
    const env = await builtin_config(['write', '~/.config/argus/desktops/trio.desk', encode('view files\n')]);
    expect(env.status).toBe('ok');
    const [localPath, remotePath] = uploadPath.mock.calls[0] ?? [];
    expect(remotePath).toBe('/home/tester/.config/argus/desktops/trio.desk');
    expect(String(localPath)).toContain('chell-config-');
    expect(replaceContent).not.toHaveBeenCalled();
  });

  it('uploads from a private copy (0600 in a folder of its own, 0700) and removes it on every way out', async () => {
    const { existsSync, statSync, readFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    let seen: { mode: number; folder: number; text: string } | null = null;
    let local: string = '';
    uploadPath.mockImplementation(async (path: string) => { local = path; seen = { mode: statSync(path).mode & 0o777, folder: statSync(dirname(path)).mode & 0o777, text: readFileSync(path, 'utf8') }; return true; });
    await builtin_config(['write', '/home/t/x.desk', encode('view files\n')]);
    expect(seen).toEqual({ mode: 0o600, folder: 0o700, text: 'view files\n' });
    expect(existsSync(dirname(local))).toBe(false);
    // A failed write removes it too.
    uploadPath.mockImplementation(async (path: string) => { local = path; return false; });
    replaceContent.mockResolvedValue({ success: false });
    await builtin_config(['write', '/home/t/x.desk', encode('a')]);
    expect(existsSync(dirname(local))).toBe(false);
  });

  it('replaces in place when a fresh upload is refused (an existing file)', async () => {
    uploadPath.mockResolvedValue(false);
    const env = await builtin_config(['write', '/home/t/x.desk', encode('a')]);
    expect(env.status).toBe('ok');
    expect(replaceContent).toHaveBeenCalledWith('/home/t/x.desk', expect.stringContaining('chell-config-'));
  });

  it('reports failure when both paths refuse', async () => {
    uploadPath.mockResolvedValue(false);
    replaceContent.mockResolvedValue({ success: false });
    const env = await builtin_config(['write', '/home/t/x.desk', encode('a')]);
    expect(env.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it('refuses a document past the note-sized limit', async () => {
    const big: string = encode('x'.repeat(300 * 1024));
    const env = await builtin_config(['write', '/home/t/x', big]);
    expect(env.status).toBe('error');
    expect(uploadPath).not.toHaveBeenCalled();
  });

  it('demands its arguments and knows only write', async () => {
    expect((await builtin_config(['write'])).renderedErr).toContain('config: write: missing operand <path>');
    expect((await builtin_config(['read', 'x'])).renderedErr).toContain("config: unknown subcommand 'read' (write)");
    expect((await builtin_config([])).renderedErr).toContain('config: missing subcommand (write)');
    expect(uploadPath).not.toHaveBeenCalled();
  });
});
