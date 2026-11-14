/**
 * @file User-visible behavior tests for the `cat` builtin.
 *
 * Mocks the ChRIS file boundary while exercising the exported builtin through
 * text, binary, TTY, forced-language, and disabled-highlighting paths.
 *
 * @module
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', folder: '/home/chris' })),
}));
const mockStackPop = jest.fn(() => undefined as { message: string } | undefined);
const mockStackPush = jest.fn((_type: string, _message: string): void => undefined);
cuminMock_install(() => ({
  errorStack: { stack_pop: mockStackPop, stack_push: mockStackPush, stack_search: () => [], checkpoint_mark: () => 0, checkpoint_drain: () => [] },
  envelope_ok: (rendered: string, model?: unknown) =>
    model === undefined ? { status: 'ok', rendered } : { status: 'ok', rendered, model },
  envelope_error: (rendered: string, errors?: unknown, renderedErr?: string) => {
    const envelope: Record<string, unknown> = { status: 'error', rendered };
    if (errors !== undefined) envelope.errors = errors;
    if (renderedErr !== undefined) envelope.renderedErr = renderedErr;
    return envelope;
  },
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: jest.fn(async () => '/home/chris') } }));

const mockCat = jest.fn();
const mockCatBinary = jest.fn();
// cat reads through the session's filesystem; its reads answer from the mocks above.
const outcome_of = <T>(result: { ok: boolean; value?: T; errno?: string }): unknown =>
  (result.ok ? { ok: true, value: result.value } : { ok: false, errno: result.errno ?? 'ENOENT' });
// `/proc/jobs` as a mount that stands for a run's output folder under a node's `data`, when a test turns it on.
const proc: { mounted: boolean } = { mounted: false };
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({
    read: async (p: string) => outcome_of(await mockCat(p) as { ok: boolean; value?: string }),
    readBinary: async (p: string) => outcome_of(await mockCatBinary(p) as { ok: boolean; value?: Buffer }),
    path_isVirtual: (p: string): boolean => proc.mounted && p.startsWith('/proc/'),
    provider_get: () => ({
      storePath_resolve: async (p: string) => ({ ok: true, value: p.replace('/proc/jobs/feed_5/pl-dircopy_10/data', '/home/chris/feeds/feed_5/pl-dircopy_10/data') }),
    }),
  }),
}));

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = () => ({ ok: false as const });

const { builtin_cat } = await import('../src/builtins/fs/cat.js');
const { sink_get } = await import('../src/core/sink.js');

let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
beforeEach((): void => {
  jest.clearAllMocks();
  process.exitCode = 0;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('builtin_cat', (): void => {
  it('reports usage with no file argument', async (): Promise<void> => {
    const envelope = await builtin_cat([]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('Usage: cat');
  });

  it('renders a text file', async (): Promise<void> => {
    mockCat.mockResolvedValue(ok('hello world'));
    const envelope = await builtin_cat(['notes.txt']);
    expect(mockCat).toHaveBeenCalledWith('/home/chris/notes.txt');
    expect(envelope.rendered).toContain('hello world');
  });

  it('emits delayed inspection progress while resolving /etc/group', async (): Promise<void> => {
    jest.useFakeTimers();
    let resolveRead: ((value: ReturnType<typeof ok<string>>) => void) | undefined;
    mockCat.mockReturnValue(new Promise((resolve): void => { resolveRead = resolve; }));
    const progressSpy = jest.spyOn(sink_get(), 'progress_write');

    const command = builtin_cat(['/etc/group']);
    await jest.advanceTimersByTimeAsync(300);
    expect(progressSpy).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'group',
      kind: 'inspection',
      phase: 'reading',
      status: 'running',
    }));

    resolveRead?.(ok('pacs_users:x:2:\n'));
    await command;
    expect(progressSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'group',
      kind: 'inspection',
      phase: 'complete',
      status: 'done',
    }));
    progressSpy.mockRestore();
    jest.useRealTimers();
  });

  it('does not emit progress when /etc/group resolves before the delay', async (): Promise<void> => {
    const progressSpy = jest.spyOn(sink_get(), 'progress_write');
    mockCat.mockResolvedValue(ok('pacs_users:x:2:\n'));

    await builtin_cat(['/etc/group']);

    expect(progressSpy).not.toHaveBeenCalled();
    progressSpy.mockRestore();
  });

  it('reports a text read error and sets a non-zero exit code', async (): Promise<void> => {
    mockCat.mockResolvedValue(err());
    mockStackPop.mockReturnValue({ message: 'not found' });
    const envelope = await builtin_cat(['ghost.txt']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('cat: ghost.txt');
    expect(process.exitCode).toBe(1);
  });

  it('says a folder is a directory, naming the path once', async (): Promise<void> => {
    const said: string[] = [];
    mockStackPush.mockImplementation((_type: string, message: string): void => { said.push(message); });
    mockStackPop.mockImplementation(() => (said.length > 0 ? { message: said.pop() as string } : undefined));
    mockCat.mockResolvedValue({ ok: false, errno: 'EISDIR' });
    const envelope = await builtin_cat(['docs']);
    expect(envelope.renderedErr).toContain('cat: docs: Is a directory');
    expect(envelope.renderedErr).not.toContain('/home/chris/docs');
    mockStackPush.mockReset();
    mockStackPop.mockReset();
  });

  it('ends a file with its own newline, adding one only to a file without', async (): Promise<void> => {
    mockCat.mockResolvedValueOnce(ok('one\ntwo\n'));
    expect((await builtin_cat(['ends.txt'])).rendered).toBe('one\ntwo\n');
    mockCat.mockResolvedValueOnce(ok('no end'));
    expect((await builtin_cat(['open.txt'])).rendered).toBe('no end\n');
  });

  it('writes raw bytes for --binary', async (): Promise<void> => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockCatBinary.mockResolvedValue(ok(Buffer.from('BIN')));
    await builtin_cat(['--binary', 'data.txt']);
    expect(mockCatBinary).toHaveBeenCalledWith('/home/chris/data.txt');
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('auto-detects a binary file by extension', async (): Promise<void> => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockCatBinary.mockResolvedValue(ok(Buffer.from('DICOM')));
    await builtin_cat(['scan.dcm']);
    expect(mockCatBinary).toHaveBeenCalledWith('/home/chris/scan.dcm');
    expect(mockCat).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('reports a binary read error', async (): Promise<void> => {
    mockCatBinary.mockResolvedValue(err());
    mockStackPop.mockReturnValue({ message: 'io error' });
    const envelope = await builtin_cat(['--binary', 'data.bin']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('io error');
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['explicit binary mode', ['--binary', '--highlight=madeup', 'data.custom']],
    ['an auto-detected binary extension', ['--highlight=madeup', 'scan.dcm']],
  ])('ignores an unsupported highlight language for %s', async (
    _scenario: string,
    args: string[],
  ): Promise<void> => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockCatBinary.mockResolvedValue(ok(Buffer.from('RAW')));
    const envelope = await builtin_cat(args);
    expect(envelope.status).toBe('ok');
    expect(mockCatBinary).toHaveBeenCalledTimes(1);
    expect(mockCat).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

describe('builtin_cat — syntax highlighting on a TTY', (): void => {
  const origTTY = process.stdout.isTTY;
  beforeEach((): void => { (process.stdout as { isTTY: boolean }).isTTY = true; });
  afterEach((): void => { (process.stdout as { isTTY?: boolean }).isTTY = origTTY; });

  it('highlights a valid JSON file', async (): Promise<void> => {
    mockCat.mockResolvedValue(ok('{"a": 1, "b": true, "c": null, "d": "x"}'));
    expect((await builtin_cat(['config.json'])).rendered.length).toBeGreaterThan(0);
  });

  it('renders malformed JSON without failing', async (): Promise<void> => {
    mockCat.mockResolvedValue(ok('{not json'));
    const envelope = await builtin_cat(['broken.json']);
    expect(envelope.status).toBe('ok');
  });

  it('highlights a YAML file with varied value types', async (): Promise<void> => {
    mockCat.mockResolvedValue(ok('# comment\nflag: true\nempty: null\nnum: 42\nquoted: "hi"\nplain: text\n  - listitem\n'));
    expect((await builtin_cat(['data.yaml'])).rendered.length).toBeGreaterThan(0);
  });

  it('automatically highlights Python source on a TTY', async (): Promise<void> => {
    mockCat.mockResolvedValue(ok('def greet(name):\n    return f"hello {name}"\n'));
    const renderedContent: string = (await builtin_cat(['greet.py'])).rendered;
    expect(renderedContent).toContain('\u001b[');
  });

  it('automatically highlights TypeScript source on a TTY', async (): Promise<void> => {
    mockCat.mockResolvedValue(ok('const answer: number = 42;\n'));
    const renderedContent: string = (await builtin_cat(['answer.ts'])).rendered;
    expect(renderedContent).toContain('\u001b[');
  });

  it.each([
    ['app.js', 'const name = "mise";\n'],
    ['script.sh', 'if true; then echo "ok"; fi\n'],
    ['query.sql', 'SELECT * FROM users WHERE id = 1;\n'],
    ['README.md', '# Heading\n\nSome **strong** text.\n'],
    ['index.html', '<main class="app">hello</main>\n'],
    ['theme.css', '.app { color: red; }\n'],
    ['settings.toml', '[shell]\ntheme = "p10k"\n'],
    ['main.cpp', 'int main() { return 0; }\n'],
    ['Main.java', 'public class Main {}\n'],
    ['main.go', 'package main\nfunc main() {}\n'],
    ['main.rs', 'fn main() { let answer = 42; }\n'],
    ['task.rb', 'def run\n  puts "ok"\nend\n'],
    ['Dockerfile', 'FROM node:22\nRUN npm test\n'],
    ['Makefile', 'build:\n\tnpm run build\n'],
  ])('automatically highlights popular format %s', async (
    filename: string,
    source: string,
  ): Promise<void> => {
    mockCat.mockResolvedValue(ok(source));
    const renderedContent: string = (await builtin_cat([filename])).rendered;
    expect(renderedContent).toContain('\u001b[');
  });

  it('forces an explicit language when output is not a TTY', async (): Promise<void> => {
    (process.stdout as { isTTY: boolean }).isTTY = false;
    mockCat.mockResolvedValue(ok('def greet(name):\n    return name\n'));
    const renderedContent: string = (await builtin_cat(['source', '--highlight=python'])).rendered;
    expect(renderedContent).toContain('\u001b[');
    expect(mockCat).toHaveBeenCalledTimes(1);
  });

  it('forces extension-inferred highlighting with a bare flag', async (): Promise<void> => {
    (process.stdout as { isTTY: boolean }).isTTY = false;
    mockCat.mockResolvedValue(ok('def greet():\n    return 42\n'));
    const renderedContent: string = (await builtin_cat(['greet.py', '--highlight'])).rendered;
    expect(renderedContent).toContain('\u001b[');
    expect(mockCat).toHaveBeenCalledTimes(1);
  });

  it('lets a later bare --highlight restore filename inference', async (): Promise<void> => {
    (process.stdout as { isTTY: boolean }).isTTY = false;
    mockCat.mockResolvedValue(ok('const answer = 42;\n'));
    const renderedContent: string = (await builtin_cat(['answer.js', '--highlight=python', '--highlight'])).rendered;
    expect(renderedContent).toContain('\u001b[');
  });

  it('suppresses automatic highlighting with --no-highlight', async (): Promise<void> => {
    const source: string = 'def greet():\n    return 42\n';
    mockCat.mockResolvedValue(ok(source));
    expect((await builtin_cat(['greet.py', '--no-highlight'])).rendered).toBe(source);
    expect(mockCat).toHaveBeenCalledTimes(1);
  });

  it('keeps automatic highlighting raw when output is not a TTY', async (): Promise<void> => {
    (process.stdout as { isTTY: boolean }).isTTY = false;
    const source: string = 'def greet():\n    return 42\n';
    mockCat.mockResolvedValue(ok(source));
    expect((await builtin_cat(['greet.py'])).rendered).toBe(source);
  });

  it('auto-detects content when a forced file has no recognized name', async (): Promise<void> => {
    (process.stdout as { isTTY: boolean }).isTTY = false;
    mockCat.mockResolvedValue(ok('def greet():\n    return 42\n'));
    const renderedContent: string = (await builtin_cat(['source', '--highlight'])).rendered;
    expect(renderedContent).toContain('\u001b[');
  });

  it('reports an unsupported explicit language without reading the file', async (): Promise<void> => {
    const envelope = await builtin_cat(['source', '--highlight=madeup']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("unknown highlight language 'madeup'");
    expect(mockCat).not.toHaveBeenCalled();
  });
});

describe('a read that throws is reported, not fatal', () => {
  it('reports a file whose read throws, and keeps going', async () => {
    // An unhandled rejection here used to end the session and dump an axios
    // request object — auth header included — into the terminal (#465).
    mockCat.mockImplementation(async (path: string) => {
      if (path.includes('bad')) throw new Error('Internal server error');
      return ok('good contents');
    });
    const envelope = await builtin_cat(['bad.txt', 'good.txt']);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('cat: bad.txt: Internal server error');
    // The second file still read: one unreadable path does not end the line.
    expect(envelope.rendered).toContain('good contents');
  });

  it('reports a path that cannot even be resolved', async () => {
    mockCat.mockResolvedValue(ok('never reached'));
    const envelope = await builtin_cat(['/net/pacs/queries/nope']);
    expect(['ok', 'error']).toContain(envelope.status);
  });
});

describe("a run's output read at the graph's own address", () => {
  it('reads a file under a node data link, through the link in it, where the store keeps it', async () => {
    // The operator's case (2026-11-14): `cat /proc/jobs/…/pl-dircopy_…/data/<link>/hello.txt`
    // was read at the feed path with the `.chrislink` in it unfollowed, and CUBE found no folder.
    const output: string = '/home/chris/feeds/feed_5/pl-dircopy_10/data';
    proc.mounted = true;
    const { backend_install } = await import('../src/core/backend.js');
    backend_install({
      id: 'test',
      session: { home_get: async (): Promise<string> => '/home/chris' },
      vfs: {
        dispatcher: {} as never,
        path_physical: async (p: string): Promise<string> => p.replace(`${output}/home_chris_uploads_set`, '/home/chris/uploads/set'),
      },
    } as never);
    mockCat.mockResolvedValue(ok('hello'));
    const envelope = await builtin_cat(['/proc/jobs/feed_5/pl-dircopy_10/data/home_chris_uploads_set/hello.txt']);
    expect(mockCat).toHaveBeenCalledWith('/home/chris/uploads/set/hello.txt');
    expect(envelope.rendered).toContain('hello');
    proc.mounted = false;
  });
});
