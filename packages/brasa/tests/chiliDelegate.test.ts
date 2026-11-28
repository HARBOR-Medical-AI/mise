import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { cuminMock_install } from './support/cuminMock.js';

const mockRunCapture = jest.fn<(argv: string[]) => Promise<{ out: string; err: string }>>();
const mockCommandNames = jest.fn<() => Promise<Set<string>>>();
jest.unstable_mockModule('@fnndsc/chili/run.js', () => ({ run: jest.fn(), run_capture: mockRunCapture, commandNames_get: mockCommandNames }));
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
}));

const { chiliCommand_run, chiliCommand_exists, chiliHostWord_refusal, chiliArgv_effective, chiliLine_read, argvRoles_read, CHILI_HOST_WORDS } = await import('../src/chris/chiliDelegate.js');
const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');

/** Installs a surface whose engine disk is, or is not, its operator's; answers how to put the old one back. */
function hostDisk_set(operators: boolean, programs: boolean = operators): () => void {
  const surface = new HeadlessSurface();
  Object.assign(surface.capabilities, { engineFilesystem: operators, engineProcesses: programs });
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

describe('argvRoles_read', () => {
  it('tells options, their values and operands apart, as Commander does', () => {
    const roles = argvRoles_read(['scan', '--filter', 'download', '--tree', '--endsWith=upload', '-ab', '--', '--hostpath', '-x'], ['--filter', '--endsWith']);
    expect(roles.operands).toEqual(['scan', '--hostpath', '-x']);
    expect([...roles.options.entries()]).toEqual([['--filter', 'download'], ['--tree', true], ['--endsWith', 'upload'], ['-a', true], ['-b', true]]);
  });

  it('gives a valued letter the rest of its cluster or the next word', () => {
    expect([...argvRoles_read(['-nf', '/etc/passwd', 'x'], ['f']).options.entries()]).toEqual([['-n', true], ['-f', '/etc/passwd']]);
    expect([...argvRoles_read(['-f/etc/passwd', 'x'], ['f']).options.entries()]).toEqual([['-f', '/etc/passwd']]);
    expect(argvRoles_read(['-nf', '/etc/passwd', 'x'], ['f']).operands).toEqual(['x']);
  });
});

describe('a chili line, read as chili reads it', () => {
  it('removes the first word that holds an = and no leading dash, as chili\'s context_parse does, and only that one', () => {
    expect(chiliArgv_effective(['path', 'a=b', 'upload', '/etc'])).toEqual(['path', 'upload', '/etc']);
    expect(chiliArgv_effective(['path', 'scan', '--filter=x', 'a=b', 'c=d'])).toEqual(['path', 'scan', '--filter=x', 'c=d']);
    expect(chiliArgv_effective(['a=b', 'path', 'upload'])).toEqual(['path', 'upload']);
    expect(chiliArgv_effective(['path', 'scan'])).toEqual(['path', 'scan']);
    // Held to chili's source: the rule is these two tests and nothing else.
    const run: string = readFileSync(new URL('../../chili/src/run.ts', import.meta.url), 'utf8');
    expect(run).toMatch(/if \(arg\.includes\("="\) && !arg\.startsWith\("-"\)\) \{/);
    expect(run).toMatch(/\.option\("-c, --config <path>", "path to config file"\)/);
  });

  it('finds the word and the subcommand past chili\'s own options and a context', () => {
    expect(chiliLine_read('path', ['-c', 'upload', 'scan'])).toMatchObject({ word: 'path', sub: 'scan' });
    expect(chiliLine_read('path', ['-s', '-v', 'upload', '/etc'])).toMatchObject({ word: 'path', sub: 'upload' });
    expect(chiliLine_read('a=b', ['path', 'upload'])).toMatchObject({ word: 'path', sub: 'upload' });
    expect(chiliLine_read('path', ['--help'])).toMatchObject({ word: 'path', sub: undefined });
    expect(chiliLine_read('path', ['scan', '--filter', 'download']).roles.operands).toEqual(['path', 'scan']);
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
    ['path', ['scan', '--tree', '--mermaid']],
    ['path', ['scan', '--mermaid', '--save', '/tmp/x.html']],
    ['path', ['scan', '--save=/tmp/x.html']],
    ['path', ['scan', '--filter', 'x', '--save', '/tmp/x.html']],
    ['path', []],
    ['path', ['-s']],
    ['path', ['somethingnew', '/etc']],
    ['chefs', ['upload', '/etc/passwd', '/home/x']],
    ['chefs', ['-s', 'upload', '/etc/passwd', '/home/x']],
    ['chefs', ['somethingnew']],
    ['inode', ['/home/x', 'file', 'create', 'x.txt', '--from-file', '/etc/passwd']],
    ['inode', ['/home/x', 'file', 'create', '--from-file=/etc/passwd', 'x.txt']],
    ['inode', ['/home/x', 'file', 'create', 'x.txt', '-f', '/etc/passwd']],
    ['inode', ['/home/x', 'file', 'create', '-n', 'x.txt', '-f', '/etc/passwd']],
    ['inode', ['/home/x', 'file', 'create', '-f/etc/passwd']],
    ['man', ['doc', '../../../../etc/notes']],
    ['man', ['doc', '/etc/notes']],
    ['man', ['doc', 'chell', '--browser']],
    ['man', ['doc', '-b', 'chell']],
    ['man', ['doc', '--style', 'ascii', '../x']],
    // A topic that begins with a dash is an operand after the end of options, and is read as one.
    ['man', ['doc', '--', '-x/../../etc/notes']],
    ['man', ['doc', '--', '--/..']],
    ['man', ['somethingnew']],
    // chili removes the first word that holds an `=` and no leading dash as its context: what is left is an upload.
    ['path', ['user@cube?folder=/x', 'upload', '/etc']],
    ['path', ['scan', 'a=b', '--hostpath', '/etc']],
    // chili's own --config takes the word after it, wherever it stands: `scan` is its value here, and the subcommand is upload.
    ['path', ['-c', 'scan', 'upload', '/etc']],
    ['path', ['--config', 'scan', 'upload', '/etc']],
    ['path', ['upload', '--config=/x', '/etc']],
    ['chefs', ['-c', 'ls', 'upload', '/etc/passwd', '/home/x']],
    // The context removed is the first such word only; the filter's own `x=y` then stays a value.
    ['man', ['a=b', 'doc', '../../etc/notes']],
  ];

  /** Lines of the same words that touch no host file, some of them carrying a touching word as a mere operand or value. */
  const HARMLESS: ReadonlyArray<[string, string[]]> = [
    ['path', ['scan']],
    ['path', ['-s', 'scan', '--tree', '--follow', '--filter', 'nii']],
    ['path', ['scan', '--filter', 'download']],
    ['path', ['scan', '--endsWith', 'upload', '--filter=--hostpath']],
    ['chefs', ['ls', '/home/x']],
    ['chefs', ['ls', 'upload']],
    ['chefs', ['-s', 'cat', 'upload']],
    ['chefs', ['touch', '/home/x/a.txt']],
    ['chefs', ['rm', 'download']],
    ['inode', ['/home/x', 'file', 'create', 'x.txt', '--content', 'hello']],
    ['inode', ['/home/x', 'file', 'create', 'x.txt', '--content', '--from-file']],
    ['inode', ['/home/x', 'files', 'delete', 'id:7', '-f']],
    ['inode', ['/home/x', 'file', 'cat']],
    ['files', ['delete', 'id:7', '-f']],
    ['files', ['share', '--force']],
    ['man', ['doc', 'chell']],
    ['man', ['doc', '--style', '../figlet', 'chell']],
    ['man', ['doc', '--', '-topic']],
    ['man', ['topics']],
    ['feeds', ['-s', 'list']],
    // `upload` is the value of chili's own --config, and the subcommand is scan.
    ['path', ['-c', 'upload', 'scan']],
    ['path', ['--config', 'download', 'scan', '--tree']],
    ['chefs', ['--config=upload', 'ls', '/home/x']],
    // A word asked only for its help runs nothing.
    ['path', ['--help']],
    ['path', ['-h']],
    ['chefs', ['-s', '--help']],
    ['man', ['-h']],
    ['path', ['help']],
    // A context is removed, and what is left is a plain scan.
    ['path', ['user@cube?folder=/x', 'scan']],
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

  it('a line that also starts a program on the host (a renderer, a browser) needs the process grant too: with the disk alone it is refused and chili is not run', async () => {
    const restore = hostDisk_set(true, false);
    try {
      for (const [command, args, what] of [['path', ['scan', '--tree', '--mermaid'], 'path scan --mermaid'], ['path', ['scan', '--mermaid', '--save', '/tmp/x.html'], 'path scan --mermaid'], ['man', ['doc', 'chell', '--browser'], 'man doc --browser']] as const) {
        expect(chiliHostWord_refusal(command, [...args])).toBe(`${what}: this session may not start programs on its host; start the session with --host-control=shell`);
        mockRunCapture.mockClear();
        expect((await chiliCommand_run(command, [...args])).status).not.toBe('ok');
        expect(mockRunCapture).not.toHaveBeenCalled();
      }
      // A line that reads or writes the disk and starts nothing still runs on the disk grant alone: --save writes a file.
      expect(chiliHostWord_refusal('path', ['upload', 'a', 'b'])).toBeNull();
      expect(chiliHostWord_refusal('path', ['scan', '--save', '/tmp/x.html'])).toBeNull();
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
      'commands/fs/create.ts': 'inode',
      'commands/fs/touch.ts': 'chefs touch takes no file; the kernel\'s own touch calls it and gates --withContentsFromFile itself',
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
    expect(Object.keys(CHILI_HOST_WORDS).sort()).toEqual(['chefs', 'man', 'path']);
    // `create`, with its --from-file, is registered once: on a single file, under `inode`. The group words have none.
    const handler: string = readFileSync(join(root, 'filesystem', 'fileGroupHandler.ts'), 'utf8');
    const group: string = handler.slice(handler.indexOf('fileGroupCommand_setup(program'), handler.indexOf('fileMemberCommand_setup(program'));
    const member: string = handler.slice(handler.indexOf('fileMemberCommand_setup(program'));
    expect(group).not.toMatch(/\.command\("create/);
    expect(member).toMatch(/\.command\("create \[fileIdentifier\]"\)/);
    expect(member).toMatch(/"-f, --from-file <localPath>"/);
    expect(member).toMatch(/"-c, --content <text>"/);
    expect(member).toMatch(/"-p, --path <path>"/);
    expect(member).toMatch(/"-n, --name <name>"/);
    expect(readFileSync(join(root, 'filesystem', 'inodeCommand.ts'), 'utf8')).toMatch(/subcommand === "file"\)[\s\S]*fileMemberCommand_setup/);
  });
});
