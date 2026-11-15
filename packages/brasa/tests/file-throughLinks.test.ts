/**
 * @file `file`, `xxd`, `strings` and the digests through a link: a file
 * behind a run's `.chrislink` is read where the link points, whether the
 * path names the link by its feed path or by the graph's own address under
 * `/proc/jobs`. `file` names the store path; the others name the path as typed.
 *
 * chili's reads stand in as the store's own, so what is read is what
 * `file` asked for.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';
import type { VfsOutcome } from '@fnndsc/fond';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({
  files_catBinary: async (path: string) => {
    const { vfsDispatcher_get } = await import('../src/core/filesystem.js');
    const read: VfsOutcome<Buffer> = await vfsDispatcher_get().readBinary(path);
    return read.ok ? { ok: true as const, value: read.value } : { ok: false as const };
  },
  files_cat: async (path: string) => {
    const { vfsDispatcher_get } = await import('../src/core/filesystem.js');
    const read: VfsOutcome<string> = await vfsDispatcher_get().read(path);
    return read.ok ? { ok: true as const, value: read.value } : { ok: false as const };
  },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_file, builtin_xxd, builtin_strings, builtin_sha256sum } = await import('../src/builtins/games/bytes.js');
type LinkedStore = ReturnType<typeof linkedStore_install>;

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

let store: LinkedStore;
beforeEach((): void => {
  process.exitCode = 0;
  store = linkedStore_install();
});

describe('file through a link', () => {
  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('reads the file where the link points, by %s', async (_how: string, link: string) => {
    const envelope: CommandEnvelope = await builtin_file([`${link}/hello.txt`]);
    expect(envelope.status).toBe('ok');
    expect(plain(envelope.rendered)).toBe(`${link}/hello.txt: ASCII text  (12 bytes)\n`);
    expect(store.calls).toContain(`readBinary ${LINKED}/hello.txt`);
    expect(envelope.model).toEqual({ kind: 'games.file', data: { files: [{ path: `${LINKED}/hello.txt`, kind: 'ASCII text', bytes: 12 }] } });
  });
});

describe('the byte readers through a link', () => {
  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('xxd reads where the link points, by %s, and names the path as typed', async (_how: string, link: string) => {
    const envelope: CommandEnvelope = await builtin_xxd([`${link}/hello.txt`]);
    expect(envelope.status).toBe('ok');
    expect(store.calls).toContain(`readBinary ${LINKED}/hello.txt`);
    expect(envelope.model).toEqual({ kind: 'games.xxd', data: { path: `${link}/hello.txt`, offset: 0, shown: 12, total: 12 } });
  });

  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('strings and sha256sum read where the link points, by %s', async (_how: string, link: string) => {
    const found: CommandEnvelope = await builtin_strings([`${link}/hello.txt`]);
    expect(plain(found.rendered)).toBe('hello\nworld\n');
    const digest: CommandEnvelope = await builtin_sha256sum([`${link}/hello.txt`]);
    expect(digest.status).toBe('ok');
    expect(plain(digest.rendered)).toContain(`${link}/hello.txt`);
    expect(store.calls.filter((call: string): boolean => call === `readBinary ${LINKED}/hello.txt`)).toHaveLength(2);
  });
});
