/**
 * @file `tree` and `du` of a link named on the line, by both addresses of a
 * run's output: read where the store keeps the folder, and shown as the
 * person asked for it. `tree /proc/jobs/…/data/<link>` hangs from that path,
 * never from the store path the link points at; `du` names its rows under it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));
jest.unstable_mockModule('../src/lib/spinner.js', () => ({ spinner: { start: jest.fn(), stop: jest.fn(), updateMessage: jest.fn() } }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/upload.js', () => ({ bytes_format: (n: number): string => `${n}B` }));

/** The folders each scan was asked for. */
const scanned: string[] = [];
/** The scan, as chili's walk answers for the link's target in the store. */
const mockScan = jest.fn(async (options: { folder?: string }) => {
  const at: string = options.folder ?? '/';
  scanned.push(at);
  const entry = (rel: string, size: number, isDirectory: boolean) => ({ id: 0, hostPath: '', chrisPath: `${at}/${rel}`, size, isLink: false, linkTarget: '', isDirectory });
  return { fileInfo: [entry('hello.txt', 12, false), entry('inner', 0, true), entry('inner/deep.txt', 5, false)], totalSize: 17 };
});
/** archy, drawn plainly: the root's label (empty), then each path on its own line. */
const mockArchy = jest.fn((files: Array<{ chrisPath: string }>): string => ['', ...files.map((file) => `- ${file.chrisPath}`)].join('\n'));
jest.unstable_mockModule('@fnndsc/chili/path/pathCommand.js', () => ({ scan_do: mockScan, archyTree_create: mockArchy }));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_tree } = await import('../src/builtins/fs/tree.js');
const { builtin_du } = await import('../src/builtins/fs/du.js');

beforeEach((): void => {
  linkedStore_install();
  scanned.length = 0;
  process.exitCode = 0;
});

describe.each([['/proc/jobs', VIA_PROC], ['the feed path', VIA_FEED]])('through a .chrislink by %s', (_how: string, typed: string) => {
  it('tree reads the target and hangs from the path as typed', async () => {
    const drawn = await builtin_tree([typed]);
    expect(scanned).toEqual([LINKED]);
    const lines: string[] = drawn.rendered.split('\n');
    expect(lines[0]).toBe(typed);
    expect(lines.slice(1, 4)).toEqual(['- hello.txt', '- inner', '- inner/deep.txt']);
    expect(drawn.rendered).not.toContain(LINKED);
  });

  it('tree --path lists every entry under the path as typed', async () => {
    const listed = await builtin_tree(['--path', typed]);
    expect(listed.rendered).toContain(`${typed}/hello.txt\n${typed}/inner\n${typed}/inner/deep.txt\n`);
    expect(listed.rendered).not.toContain(LINKED);
  });

  it('du sizes the target and names its rows under the path as typed', async () => {
    const sized = await builtin_du([typed]);
    expect(scanned).toEqual([LINKED]);
    expect(sized.rendered).toContain(`\t${typed}\n`);
    expect(sized.rendered).toContain(`\t${typed}/inner\n`);
    expect(sized.rendered).not.toContain(LINKED);
  });

  it('du of a file behind the link names it as typed', async () => {
    const sized = await builtin_du([`${typed}/hello.txt`]);
    expect(sized.rendered).toContain(`\t${typed}/hello.txt\n`);
  });
});
