/**
 * @file `edit` through a link: a file behind a run's `.chrislink` is read
 * and saved where the link points, whether the path names the link by its
 * feed path or by the graph's own address under `/proc/jobs`; a folder that
 * refuses the write fails the save, and says so.
 *
 * chili's read and replace stand in as the store's own read and write, so
 * what lands in the store is what `edit` handed them.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { readFileSync, rmSync } from 'node:fs';
import type { CommandEnvelope } from '@fnndsc/menu';
import type { VfsOutcome } from '@fnndsc/fond';
import { cuminMock_install } from './support/cuminMock.js';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));
const mockInvalidate = jest.fn();
cuminMock_install(() => ({ listCache_get: () => ({ cache_invalidate: mockInvalidate }) }));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));

/** The session's dispatcher: the linked store, once installed. */
const dispatcher_get = async () => (await import('../src/core/filesystem.js')).vfsDispatcher_get();

// salsa's dispatcher is the session's own in a ChRIS session; here, the store's.
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  vfsDispatcher: {
    path_isVirtual: (_path: string): boolean => false,
    read: async (path: string): Promise<VfsOutcome<string>> => (await dispatcher_get()).read(path),
    write: async (path: string, content: string): Promise<VfsOutcome> => (await dispatcher_get()).write(path, content),
  },
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({
  files_cat: async (path: string) => {
    const read: VfsOutcome<string> = await (await dispatcher_get()).read(path);
    return read.ok ? { ok: true as const, value: read.value } : { ok: false as const };
  },
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/edit.js', () => ({
  file_replaceContent: async (path: string, local: string) => {
    const written: VfsOutcome = await (await dispatcher_get()).write(path, readFileSync(local, 'utf8'));
    return written.ok ? { success: true } : { success: false, error: `could not write ${path}` };
  },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_edit } = await import('../src/builtins/fs/edit.js');
const { surface_set } = await import('../src/core/surface.js');
import type { LocalEditRequest, LocalEditResult, Surface } from '../src/core/surface.js';
type LinkedStore = ReturnType<typeof linkedStore_install>;

const mockLocalEdit = jest.fn(async (request: LocalEditRequest): Promise<LocalEditResult> => ({ content: `${request.content}edited\n`, changed: true }));

let store: LinkedStore;
beforeEach((): void => {
  jest.clearAllMocks();
  process.exitCode = 0;
  store = linkedStore_install();
  const surface: Surface = {
    capabilities: { hiddenInput: true, localEdit: true, tty: true, pipeSegments: true },
    prompt: async (): Promise<string> => '',
    pipeSegment: async (_command: string, input: Buffer): Promise<Buffer> => input,
    localEdit: mockLocalEdit,
  };
  surface_set(surface);
});

describe('edit through a link', () => {
  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('reads and saves the file where the link points, by %s', async (_how: string, link: string) => {
    const envelope: CommandEnvelope = await builtin_edit([`${link}/hello.txt`]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain(`Saved: ${link}/hello.txt`);
    expect(mockLocalEdit).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello\nworld\n', path: `${LINKED}/hello.txt` }));
    expect(store.calls).toEqual(expect.arrayContaining([`read ${LINKED}/hello.txt`, `write ${LINKED}/hello.txt`]));
    expect(store.entries.get(`${LINKED}/hello.txt`)?.content).toBe('hello\nworld\nedited\n');
    expect(store.entries.has(`${VIA_FEED}/hello.txt`)).toBe(false);
    expect(store.entries.get(VIA_FEED)?.type).toBe('link');
    expect(mockInvalidate).toHaveBeenCalledWith(LINKED);
    expect(mockInvalidate).toHaveBeenCalledWith(link);
  });

  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('fails, and says so, when the folder the link points at refuses the write, by %s', async (_how: string, link: string) => {
    store.refusing.add(LINKED);
    const envelope: CommandEnvelope = await builtin_edit([`${link}/hello.txt`]);
    expect(envelope.status).toBe('error');
    expect(process.exitCode).toBe(1);
    expect(envelope.renderedErr).toContain('Save failed');
    expect(envelope.renderedErr).toContain(`could not write ${LINKED}/hello.txt`);
    expect(store.entries.get(`${LINKED}/hello.txt`)?.content).toBe('hello\nworld\n');
    // The edits are kept on the host for the operator; this test has no use for them.
    const kept: string | undefined = /preserved at: ([^\s\x1b]+)/.exec(envelope.renderedErr ?? '')?.[1];
    if (kept !== undefined) rmSync(kept, { force: true });
  });
});
