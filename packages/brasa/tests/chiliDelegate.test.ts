import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockRunCapture = jest.fn<(argv: string[]) => Promise<{ out: string; err: string }>>();
const mockCommandNames = jest.fn<() => Promise<Set<string>>>();
jest.unstable_mockModule('@fnndsc/chili/run.js', () => ({ run: jest.fn(), run_capture: mockRunCapture, commandNames_get: mockCommandNames }));
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
}));

const { chiliCommand_run, chiliCommand_exists, chiliHostWord_refusal, CHILI_HOST_WORDS } = await import('../src/chris/chiliDelegate.js');
const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');

/** Installs a surface whose engine disk is, or is not, its operator's; answers how to put the old one back. */
function hostDisk_set(operators: boolean): () => void {
  const surface = new HeadlessSurface();
  Object.assign(surface.capabilities, { engineFilesystem: operators });
  const previous = surface_set(surface);
  return (): void => { surface_set(previous); };
}

describe('chiliCommand_run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = 0;
  });

  it('forwards the command and args to chili and returns the captured output', async () => {
    mockRunCapture.mockResolvedValue({ out: 'FEED_TABLE\n', err: '' });
    const envelope = await chiliCommand_run('feeds', ['-s', 'x']);
    expect(mockRunCapture).toHaveBeenCalledWith(['feeds', '-s', 'x']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toBe('FEED_TABLE\n');
    expect(envelope.renderedErr).toBeUndefined();
  });

  it('carries captured error output in renderedErr', async () => {
    mockRunCapture.mockResolvedValue({ out: '', err: 'bad thing\n' });
    const envelope = await chiliCommand_run('feeds', []);
    expect(envelope.renderedErr).toBe('bad thing\n');
  });

  it('reports a thrown failure without throwing', async () => {
    mockRunCapture.mockRejectedValue(new Error('boom'));
    const envelope = await chiliCommand_run('feeds', []);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain("chili command 'feeds' failed");
    expect(process.exitCode).toBe(1);
  });
});

describe('chiliCommand_exists', () => {
  it('is true for a command chili exposes and false otherwise', async () => {
    mockCommandNames.mockResolvedValue(new Set(['feeds', 'plugins', 'files']));
    expect(await chiliCommand_exists('feeds')).toBe(true);
    expect(await chiliCommand_exists('files')).toBe(true);
    expect(await chiliCommand_exists('fortune')).toBe(false);
  });
});

describe('chili\'s words that touch the host\'s disk', () => {
  /** Lines that read or write a file on the machine chili runs on, however their options are placed. */
  const TOUCHING: ReadonlyArray<[string, string[]]> = [
    ['path', ['upload', '/etc']],
    ['path', ['-s', 'upload', '/etc']],
    ['path', ['download']],
    ['path', ['download', '-f', '/tmp/out']],
    ['path', ['scan', '--hostpath', '/etc']],
    ['path', ['scan', '--hostpath=/etc']],
    ['path', ['--hostpath', '/etc', 'scan']],
    ['path', ['scan', '--mermaid', '--save', '/tmp/x.html']],
    ['path', ['scan', '--save=/tmp/x.html']],
    ['path', []],
    ['path', ['somethingnew', '/etc']],
    ['chefs', ['upload', '/etc/passwd', '/home/x']],
    ['chefs', ['-s', 'upload', '/etc/passwd', '/home/x']],
    ['files', ['create', 'x.txt', '--from-file', '/etc/passwd']],
    ['files', ['create', '--from-file=/etc/passwd', 'x.txt']],
    ['files', ['--from-file', '/etc/passwd', 'create', 'x.txt']],
    ['files', ['create', 'x.txt', '-f', '/etc/passwd']],
    ['files', ['create', '-nf', 'x.txt', '/etc/passwd']],
    ['links', ['create', 'x', '-f', '/etc/passwd']],
    ['dirs', ['create', 'x', '--from-file', '/etc/passwd']],
    ['man', ['doc', '../../../../etc/notes']],
    ['man', ['doc', '/etc/notes']],
    ['man', ['doc', 'chell', '--browser']],
    ['man', ['doc', '-b', 'chell']],
  ];

  /** Lines of the same words that touch no host file. */
  const HARMLESS: ReadonlyArray<[string, string[]]> = [
    ['path', ['scan']],
    ['path', ['-s', 'scan', '--tree', '--follow', '--filter', 'nii']],
    ['chefs', ['ls', '/home/x']],
    ['chefs', ['touch', '/home/x/a.txt']],
    ['files', ['create', 'x.txt', '--content', 'hello']],
    ['files', ['delete', 'id:7', '-f']],
    ['files', ['share', '--force']],
    ['man', ['doc', 'chell']],
    ['man', ['topics']],
    ['feeds', ['-s', 'list']],
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = 0;
    mockRunCapture.mockResolvedValue({ out: 'ran\n', err: '' });
  });

  it.each(TOUCHING)('%s %j is refused where the disk is nobody\'s, and chili is not run', async (command: string, args: string[]) => {
    const restore = hostDisk_set(false);
    try {
      const envelope = await chiliCommand_run(command, args);
      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain("the session's host disk is nobody's; start the session with --host-control=files");
      expect(envelope.renderedErr).toContain(command);
      expect(mockRunCapture).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      restore();
    }
  });

  it.each(TOUCHING)('%s %j reaches chili where the disk is the operator\'s', async (command: string, args: string[]) => {
    const restore = hostDisk_set(true);
    try {
      expect((await chiliCommand_run(command, args)).status).toBe('ok');
      expect(mockRunCapture).toHaveBeenCalledWith([command, ...args]);
    } finally {
      restore();
    }
  });

  it.each(HARMLESS)('%s %j reaches chili either way', async (command: string, args: string[]) => {
    for (const operators of [false, true]) {
      const restore = hostDisk_set(operators);
      try {
        expect(chiliHostWord_refusal(command, args)).toBeNull();
        expect((await chiliCommand_run(command, args)).status).toBe('ok');
      } finally {
        restore();
      }
    }
  });

  it('every file of chili that opens the host\'s disk belongs to a word the table knows, or reads only chili\'s own files', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root: string = new URL('../../chili/src', import.meta.url).pathname;
    /** Each file that imports `fs`, and the top-level word (or the reason) that accounts for it. */
    const ACCOUNTED: Readonly<Record<string, string>> = {
      'path/pathCommand.ts': 'path',
      'commands/fs/download.ts': 'path',
      'commands/fs/upload.ts': 'chefs',
      'commands/fs/create.ts': 'files',
      'commands/fs/touch.ts': 'chefs touch takes no file; the kernel\'s own touch calls it and gates --withContentsFromFile itself',
      'lfs/lfs.ts': 'not registered: no command reaches it',
      'man/renderer.ts': 'man',
      'commands/man/doc.ts': 'man',
      'commands/man/topics.ts': 'man topics lists chili\'s own doc folder',
      'config/colorConfigLoad.ts': 'chili\'s own colour configuration',
    };
    const opening: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const at: string = join(folder, entry.name);
        if (entry.isDirectory()) walk(at);
        else if (entry.name.endsWith('.ts') && /from\s+['"](node:)?fs(\/promises)?['"]/.test(readFileSync(at, 'utf8'))) opening.push(at.slice(root.length + 1));
      }
    };
    walk(root);
    expect(opening.sort()).toEqual(Object.keys(ACCOUNTED).sort());
    for (const word of ['path', 'chefs', 'files', 'man']) expect(CHILI_HOST_WORDS).toContain(word);
    // lfs stays unreachable: were it registered, its words would need a rule.
    expect(readFileSync(join(root, 'run.ts'), 'utf8')).not.toMatch(/lfsCommand_setup/);
  });
});
