/**
 * @file `upload` through a link: an upload into a run's `.chrislink`
 * lands in the folder the link points at, whether the destination names
 * the link by its feed path or by the graph's own address under
 * `/proc/jobs`; a folder that refuses the write fails the upload, and says so.
 *
 * chili's transfer stands in as the store's own write of each file into
 * the folder it is handed, so what lands in the store is where `upload`
 * sent it.
 */
import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CommandEnvelope } from '@fnndsc/menu';
import type { VfsOutcome } from '@fnndsc/fond';
import { cuminMock_install } from './support/cuminMock.js';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));
const mockInvalidate = jest.fn();
const mockInvalidateTree = jest.fn();
cuminMock_install(() => ({ listCache_get: () => ({ cache_invalidate: mockInvalidate, cache_invalidateTree: mockInvalidateTree }) }));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));

/** The upload's options, as far as this stand-in reads them. */
interface UploadNotices {
  /** Where a failed file is said. */
  onNotice?: (message: string, channel: 'status' | 'err') => void;
}

jest.unstable_mockModule('@fnndsc/chili/commands/fs/upload.js', () => ({
  bytes_format: (bytes: number): string => `${bytes} B`,
  files_uploadWithProgress: async (local: string, remote: string, options: UploadNotices) => {
    const { vfsDispatcher_get } = await import('../src/core/filesystem.js');
    const content: string = readFileSync(local, 'utf8');
    const written: VfsOutcome = await vfsDispatcher_get().write(`${remote}/${basename(local)}`, content);
    if (!written.ok) options.onNotice?.(`Failed to upload: ${local}`, 'err');
    return {
      startTime: 0, endTime: 1, totalFiles: 1, duration: 1, speed: content.length, actualTargetPath: remote,
      transferredCount: written.ok ? 1 : 0, failedCount: written.ok ? 0 : 1, transferSize: written.ok ? content.length : 0,
      failedPaths: written.ok ? [] : [local], cancelledCount: 0,
    };
  },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_upload } = await import('../src/builtins/fs/upload.js');
const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');
type LinkedStore = ReturnType<typeof linkedStore_install>;

const LOCAL_DIR: string = mkdtempSync(join(tmpdir(), 'upload-links-'));
const LOCAL_FILE: string = join(LOCAL_DIR, 'note.txt');
writeFileSync(LOCAL_FILE, 'a note\n');

let store: LinkedStore;
beforeEach((): void => {
  jest.clearAllMocks();
  process.exitCode = 0;
  store = linkedStore_install();
  // The engine's disk is the operator's here, as in a local shell.
  const surface = new HeadlessSurface() as unknown as { capabilities: { engineFilesystem: boolean } };
  surface.capabilities = { ...surface.capabilities, engineFilesystem: true };
  surface_set(surface as never);
  jest.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
});

afterAll((): void => {
  rmSync(LOCAL_DIR, { recursive: true, force: true });
});

describe('upload through a link', () => {
  it.each([
    ['the graph address', VIA_PROC],
    ['the feed path', VIA_FEED],
    ['the feed path, as a folder', `${VIA_FEED}/`],
  ])('lands in the folder the link points at, by %s', async (_how: string, link: string) => {
    const envelope: CommandEnvelope = await builtin_upload([LOCAL_FILE, link]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('Successfully uploaded 1 file');
    expect(store.calls).toContain(`write ${LINKED}/note.txt`);
    expect(store.entries.get(`${LINKED}/note.txt`)?.content).toBe('a note\n');
    expect(store.entries.has(`${VIA_FEED}/note.txt`)).toBe(false);
    expect(store.entries.get(VIA_FEED)?.type).toBe('link');
    expect(mockInvalidate).toHaveBeenCalledWith(LINKED);
    expect(mockInvalidate).toHaveBeenCalledWith(link.replace(/\/$/, ''));
  });

  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('fails, and says so, when the folder the link points at refuses the write, by %s', async (_how: string, link: string) => {
    store.refusing.add(LINKED);
    const envelope: CommandEnvelope = await builtin_upload([LOCAL_FILE, link]);
    expect(envelope.status).toBe('error');
    expect(process.exitCode).toBe(1);
    expect(envelope.rendered).toContain('Uploaded 0 file(s), 1 failed');
    expect(store.calls).toContain(`write ${LINKED}/note.txt`);
    expect(store.entries.has(`${LINKED}/note.txt`)).toBe(false);
  });
});
