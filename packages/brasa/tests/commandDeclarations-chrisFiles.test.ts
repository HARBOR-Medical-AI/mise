/**
 * @file The ChRIS Files commands `edit`, `config`, `upload` and `file`,
 * each declared in one record: a bad line is refused in the parser's words
 * before the handler runs, `--` ends the options, the typed line reaches
 * the handler, and the usage, help and holds come from the declaration.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';
import { cuminMock_install } from './support/cuminMock.js';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/chris' },
}));
cuminMock_install(() => ({ listCache_get: () => ({ cache_invalidate: jest.fn(), cache_invalidateTree: jest.fn() }) }));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
const mockUploadPath = jest.fn(async (_local: string, _remote: string): Promise<boolean> => true);
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  files_uploadPath: mockUploadPath,
  vfsDispatcher: { path_isVirtual: (): boolean => false },
}));
const mockCat = jest.fn(async (_path: string) => ({ ok: true as const, value: 'text' }));
const mockCatBinary = jest.fn(async (_path: string) => ({ ok: true as const, value: Buffer.from('plain words\n') }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({ files_cat: mockCat, files_catBinary: mockCatBinary }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/edit.js', () => ({ file_replaceContent: jest.fn(async () => ({ success: true })) }));
const mockUpload = jest.fn(async (_local: string, _remote: string, _options: Record<string, unknown>) => ({
  startTime: 0, endTime: 1, totalFiles: 1, transferredCount: 1, failedCount: 0, transferSize: 1, duration: 1, speed: 1, actualTargetPath: '/home/chris/in', failedPaths: [], cancelledCount: 0,
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/upload.js', () => ({ files_uploadWithProgress: mockUpload, bytes_format: (bytes: number): string => `${bytes} B` }));

const { editCommand, builtin_edit } = await import('../src/builtins/fs/edit.js');
const { configCommand, builtin_config } = await import('../src/builtins/fs/configWrite.js');
const { uploadCommand, builtin_upload } = await import('../src/builtins/fs/upload.js');
const { fileCommand, builtin_file } = await import('../src/builtins/games/bytes.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');
const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');
const { variable_set, variable_unset, textAnswer_make } = await import('../src/core/variables.js');
const { commandCancellation_run } = await import('../src/core/cancellation.js');

beforeEach((): void => {
  jest.clearAllMocks();
  process.exitCode = 0;
  // A local shell: it edits in place, and the engine's disk is the operator's.
  const surface = new HeadlessSurface() as unknown as { capabilities: Record<string, boolean>; localEdit: () => Promise<{ content: string; changed: boolean }> };
  surface.capabilities = { ...surface.capabilities, engineFilesystem: true, localEdit: true };
  surface.localEdit = async () => ({ content: 'text', changed: false });
  surface_set(surface as never);
});

/**
 * Asserts a line was refused by the parser, exit status 1.
 *
 * @param envelope - The command's answer.
 * @param words - What the refusal says.
 */
function refusal_expect(envelope: CommandEnvelope, words: string): void {
  expect(envelope.status).toBe('error');
  expect(envelope.renderedErr).toContain(words);
  expect(process.exitCode).toBe(1);
}

describe('a bad line is refused before the handler runs', () => {
  it('edit', async () => {
    refusal_expect(await builtin_edit(['-q', 'notes.txt']), "edit: invalid option -- 'q'; usage: edit <file>");
    refusal_expect(await builtin_edit(['a.txt', 'b.txt']), "edit: unexpected operand 'b.txt'");
    expect(mockCat).not.toHaveBeenCalled();
  });

  it('config', async () => {
    refusal_expect(await builtin_config(['write', '--force', '~/x.desk', 'YQ==']), "config: write: unrecognized option '--force'; usage: config write <path> <content>");
    refusal_expect(await builtin_config(['write', '~/x.desk']), 'config: write: missing operand <content>');
    expect(mockUploadPath).not.toHaveBeenCalled();
  });

  it('upload', async () => {
    refusal_expect(await builtin_upload(['--recursive', 'a.txt', 'in']), "upload: unrecognized option '--recursive'; usage: upload [--jobs <N>] <source> <destination>");
    refusal_expect(await builtin_upload(['a.txt']), 'upload: missing operand <destination>');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('file', async () => {
    refusal_expect(await builtin_file(['-b', 'a.txt']), "file: invalid option -- 'b'");
    refusal_expect(await builtin_file([]), 'file: missing operand <path>');
    expect(mockCatBinary).not.toHaveBeenCalled();
  });
});

describe('-- ends the options, and the typed line reaches the handler', () => {
  it('edit reads the one file named, a dash and all', async () => {
    expect((await builtin_edit(['--', '-notes.txt'])).status).toBe('ok');
    expect(mockCat).toHaveBeenCalledWith('/home/chris/-notes.txt');
  });

  it('config writes the decoded document to the path after `write`', async () => {
    const envelope: CommandEnvelope = await builtin_config(['write', '--', '-odd.desk', Buffer.from('hi').toString('base64')]);
    expect(envelope.rendered).toContain('wrote /home/chris/-odd.desk (2 bytes)');
    expect(mockUploadPath).toHaveBeenCalledWith(expect.stringContaining('chell-config-'), '/home/chris/-odd.desk');
  });

  it('upload hands chili the host path as typed, a wildcard to match, and the store path', async () => {
    expect((await builtin_upload(['--', '-local.txt', 'in'])).status).toBe('ok');
    expect(mockUpload).toHaveBeenCalledWith('-local.txt', '/home/chris/in', expect.objectContaining({ expandLocalGlob: false }));
    await builtin_upload(['~/Pictures/earth*', 'in']);
    expect(mockUpload).toHaveBeenLastCalledWith('~/Pictures/earth*', '/home/chris/in', expect.objectContaining({ expandLocalGlob: true }));
  });

  it('file names every path it is given', async () => {
    const envelope: CommandEnvelope = await builtin_file(['--', '-a.txt', 'b.txt']);
    expect(envelope.status).toBe('ok');
    expect(mockCatBinary.mock.calls.map((call) => call[0])).toEqual(['/home/chris/-a.txt', '/home/chris/b.txt']);
  });
});

describe('upload: files at once', () => {
  /** The options the last upload was handed. */
  const optionsGiven = (): Record<string, unknown> => (mockUpload.mock.calls.at(-1) as [string, string, Record<string, unknown>])[2];

  beforeEach(() => { variable_unset('TRANSFER_JOBS'); });

  it('hands the pool 8 by default, the line\'s -j, the session\'s TRANSFER_JOBS, and the cancel signal', async () => {
    await builtin_upload(['./study', 'in']);
    expect(optionsGiven()['jobs']).toBe(8);
    await builtin_upload(['-j', '1', './study', 'in']);
    expect(optionsGiven()['jobs']).toBe(1);
    variable_set('TRANSFER_JOBS', textAnswer_make('12', 'TRANSFER_JOBS=12'));
    await builtin_upload(['./study', 'in']);
    expect(optionsGiven()['jobs']).toBe(12);
    await commandCancellation_run(async () => builtin_upload(['./study', 'in']));
    expect(optionsGiven()['signal']).toBeInstanceOf(AbortSignal);
  });

  it('refuses -j above 32 and a TRANSFER_JOBS out of range, before anything moves', async () => {
    refusal_expect(await builtin_upload(['--jobs', '64', './study', 'in']), 'at most 32');
    variable_set('TRANSFER_JOBS', textAnswer_make('33', 'TRANSFER_JOBS=33'));
    refusal_expect(await builtin_upload(['./study', 'in']), 'upload: TRANSFER_JOBS is 33; it says how many files move at once, a whole number from 1 to 32');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('names each file that failed, and fails the line', async () => {
    mockUpload.mockResolvedValueOnce({
      startTime: 0, endTime: 1, totalFiles: 3, transferredCount: 2, failedCount: 1, transferSize: 2, duration: 1, speed: 2, actualTargetPath: '/home/chris/in/study',
      failedPaths: ['./study/b.dcm'] as never[], cancelledCount: 0,
    });
    const envelope: CommandEnvelope = await builtin_upload(['./study', 'in']);
    expect(envelope.status).toBe('error');
    expect(process.exitCode).toBe(1);
    expect(envelope.rendered).toContain('Uploaded 2 file(s), 1 failed');
    expect(envelope.rendered).toContain('  failed: ./study/b.dcm\n');
  });
});

describe('usage, help and holds, from the declaration', () => {
  it('generates each usage from its grammar', () => {
    expect(commandUsage_render(editCommand)).toBe('edit <file>');
    expect(commandUsage_render(configCommand)).toBe('config <write <path> <content>>');
    expect(commandUsage_render(uploadCommand)).toBe('upload [--jobs <N>] <source> <destination>');
    expect(commandUsage_render(fileCommand)).toBe('file <path…>');
  });

  it('lists each under Files; file mirrors POSIX file and holds nothing, the rest hold the session', () => {
    for (const declaration of [editCommand, configCommand, uploadCommand, fileCommand]) expect(declaration.help.category).toBe('Files');
    expect(fileCommand.help.posix?.group).toBe('Files');
    expect(fileCommand.holds).toEqual([]);
    for (const declaration of [editCommand, configCommand, uploadCommand]) expect(declaration.holds).toBeUndefined();
  });

  it('operand kinds: CFS paths, a host path for what upload reads, a word for the document', () => {
    expect(editCommand.grammar.operands.map((operand) => operand.kind)).toEqual(['cfsPath']);
    expect(uploadCommand.grammar.operands.map((operand) => operand.kind)).toEqual(['hostPath', 'cfsPath']);
    expect(configCommand.grammar.subcommands.write.operands.map((operand) => operand.kind)).toEqual(['cfsPath', 'word']);
    expect(fileCommand.grammar.operands.map((operand) => operand.kind)).toEqual(['cfsPath']);
  });
});
