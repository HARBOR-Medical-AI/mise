/**
 * @file Tests for the CLI surface: capabilities, one-shot prompting (execute
 * and script modes) and persistent prompting on the REPL's readline interface
 * (including hidden-input echo suppression).
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

/** A controllable fake of a readline interface. */
interface FakeInterface {
  question: jest.Mock;
  close: jest.Mock;
  once: jest.Mock;
}

let lastCreated: FakeInterface | undefined;
let lastCreateOptions: { output?: unknown; terminal?: boolean } | undefined;
/** Whether a fake interface answers its question; false, it waits as on an input that ends. */
let fakeAnswers: boolean = true;
const mockCreateInterface = jest.fn((opts: { output?: unknown; terminal?: boolean }): FakeInterface => {
  lastCreateOptions = opts;
  const closers: Array<() => void> = [];
  const rl: FakeInterface = {
    // Answer immediately with an untrimmed value to prove trimming.
    question: jest.fn((_prompt: string, cb: (answer: string) => void) => { if (fakeAnswers) cb('  typed  '); }),
    // As readline's own: closing says 'close' to whoever listens.
    close: jest.fn(() => { for (const closer of closers.splice(0)) closer(); }),
    once: jest.fn((event: string, listener: () => void) => { if (event === 'close') closers.push(listener); }),
  };
  lastCreated = rl;
  return rl;
});
jest.unstable_mockModule('readline', () => ({ createInterface: mockCreateInterface }));
const spawnMock = jest.fn(() => {
  const child = new EventEmitter();
  process.nextTick(() => child.emit('close', 0));
  return child;
});
const spawnSyncMock = jest.fn((_editor: string, _args: string[]) => ({ error: undefined }));
jest.unstable_mockModule('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));
// Isolate this surface unit from the engine: cliSurface uses only
// segment_pipeThrough and file_read from brasa at runtime (the rest are
// erased types). file_read is the default byte source for delivery, so a
// stub stands in for a real session.
const fileReadMock = jest.fn(async (): Promise<Buffer> => Buffer.from('delivered bytes'));
// The placing of a delivered name is fond's own function, as brasa hands it on.
const { wireName_place } = await import('@fnndsc/fond');
jest.unstable_mockModule('@fnndsc/brasa', () => ({
  segment_pipeThrough: jest.fn(async (): Promise<Buffer> => Buffer.from('')),
  file_read: fileReadMock,
  wireName_place,
}));

const { cliSurface_create, promptLine_render, promptAnswer_take, oneShotPrompt_ask, INPUT_ENDED_REASON } =
  await import('../src/core/cliSurface.js');
const { typeahead_push, typeahead_clear, typeahead_count, question_isOpen, interrupt_set } = await import('../src/core/lineDiscipline.js');

let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
beforeEach(() => {
  jest.clearAllMocks();
  lastCreated = undefined;
  lastCreateOptions = undefined;
  fakeAnswers = true;
  writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('cliSurface capabilities', () => {
  it('declares local input and editing, and a tty matching stdout', () => {
    const caps = cliSurface_create().capabilities;
    expect(caps.hiddenInput).toBe(true);
    expect(caps.localEdit).toBe(true);
    expect(caps.tty).toBe(!!process.stdout.isTTY);
    expect(caps.shellCommands).toBe(true);
  });

  it('does not start a shell asked for after Ctrl-C stopped its command', async () => {
    spawnMock.mockClear();
    interrupt_set(true);
    await expect(cliSurface_create().shellCommand('sleep 30')).resolves.toBe(130);
    expect(spawnMock).not.toHaveBeenCalled();
    interrupt_set(false);
  });

  it('runs a shell command on the CLI host with inherited terminal I/O', async () => {
    await expect(cliSurface_create().shellCommand('pwd')).resolves.toBe(0);
    expect(spawnMock).toHaveBeenCalledWith('pwd', {
      shell: true,
      stdio: 'inherit',
      env: process.env,
    });
  });
});

describe('one-shot prompting (no REPL interface)', () => {
  it('asks a visible question on a fresh interface and trims the answer', async () => {
    const answer = await cliSurface_create().prompt({ message: 'Name? ' });
    expect(mockCreateInterface).toHaveBeenCalledTimes(1);
    expect(lastCreated!.question).toHaveBeenCalledWith('Name? ', expect.any(Function));
    expect(lastCreated!.close).toHaveBeenCalled();
    expect(answer).toBe('typed');
  });

  it('reads hidden input through a muted output and prints the prompt itself', async () => {
    const answer = await cliSurface_create().prompt({ message: 'Password: ', hidden: true });
    // Hidden path builds the interface with a muted output and terminal mode,
    // and writes the prompt to stdout directly (not through readline echo).
    expect(lastCreateOptions!.terminal).toBe(true);
    expect(lastCreateOptions!.output).not.toBe(process.stdout);
    expect(writeSpy).toHaveBeenCalledWith('Password: ');
    expect(answer).toBe('typed');
  });

  it('fails a question asked on an input that has already ended, without waiting on it', async () => {
    const ended = new PassThrough();
    ended.end();
    ended.resume();
    await new Promise((resolve) => ended.once('end', resolve));
    await expect(oneShotPrompt_ask({ message: 'go on? ', wants: 'confirm' }, ended)).rejects.toThrow(INPUT_ENDED_REASON);
    await expect(oneShotPrompt_ask({ message: 'Password: ', hidden: true }, ended)).rejects.toThrow(INPUT_ENDED_REASON);
    expect(mockCreateInterface).not.toHaveBeenCalled();
  });

  it('fails a question whose input ends before a line is typed, visible or hidden', async () => {
    fakeAnswers = false;
    const open = new PassThrough();
    const visible = oneShotPrompt_ask({ message: 'go on? ', wants: 'confirm' }, open);
    lastCreated!.close();
    await expect(visible).rejects.toThrow(INPUT_ENDED_REASON);
    // The question's line is ended, so the command's next words start a line of their own.
    expect(writeSpy).toHaveBeenLastCalledWith('\n');
    const hidden = oneShotPrompt_ask({ message: 'Password: ', hidden: true }, open);
    lastCreated!.close();
    await expect(hidden).rejects.toThrow(INPUT_ENDED_REASON);
  });
});

describe('persistent prompting (REPL interface)', () => {
  it('asks a visible question on the provided interface without creating one', async () => {
    const rl = {
      question: jest.fn((_p: string, _o: unknown, cb: (a: string) => void) => cb('  hi  ')),
      once: jest.fn(), off: jest.fn(),
    } as unknown as import('readline').Interface;
    const answer = await cliSurface_create(rl).prompt({ message: 'Q? ' });
    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(answer).toBe('hi');
  });

  it('answers a visible question with a line typed ahead, without waiting at the terminal', async () => {
    typeahead_clear();
    typeahead_push('n');
    const rl = { question: jest.fn() } as unknown as import('readline').Interface;
    const answer = await cliSurface_create(rl).prompt({ message: 'Another game: ' });
    expect(answer).toBe('n');
    expect((rl.question as jest.Mock)).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith('Another game: n\n');
    expect(typeahead_count()).toBe(0);
  });

  it('marks the question open while it waits, and never answers a secret from what was typed ahead', async () => {
    typeahead_clear();
    let openWhileAsked: boolean = false;
    const rl = {
      question: jest.fn((_p: string, _o: unknown, cb: (a: string) => void) => { openWhileAsked = question_isOpen(); cb('typed'); }),
      once: jest.fn(), off: jest.fn(),
    } as unknown as import('readline').Interface;
    await cliSurface_create(rl).prompt({ message: 'Q? ' });
    expect(openWhileAsked).toBe(true);
    expect(question_isOpen()).toBe(false);
    typeahead_push('not-a-password');
    const hidden = {
      question: jest.fn((_p: string, cb: (a: string) => void) => cb('secret')),
    } as unknown as import('readline').Interface;
    Reflect.set(hidden, '_writeToOutput', (): void => undefined);
    expect(await cliSurface_create(hidden).prompt({ message: 'Password: ', hidden: true })).toBe('secret');
    expect(typeahead_count()).toBe(1);
    typeahead_clear();
  });

  it('Ctrl-C at an open question abandons it: the asking command is told, and the question closes', async () => {
    typeahead_clear();
    const { EventEmitter } = await import('events');
    const rl = Object.assign(new EventEmitter(), {
      question: jest.fn((_p: string, options: { signal: AbortSignal }, _cb: (a: string) => void) => { expect(options.signal.aborted).toBe(false); }),
    }) as unknown as import('readline').Interface;
    const asked: Promise<string> = cliSurface_create(rl).prompt({ message: 'Another game: ' });
    expect(question_isOpen()).toBe(true);
    (rl as unknown as import('events').EventEmitter).emit('SIGINT');
    await expect(asked).rejects.toThrow('the operator abandoned the question');
    expect(question_isOpen()).toBe(false);
    const signal: AbortSignal = ((rl.question as unknown as jest.Mock).mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
  });

  it('suppresses echo for hidden input and restores it afterward', async () => {
    const original = jest.fn();
    let suppressedDuringQuestion: boolean | undefined;
    const rl = {
      _writeToOutput: original,
      question: jest.fn((_p: string, cb: (a: string) => void) => {
        // Capture whether the echo hook was swapped out while awaiting input.
        suppressedDuringQuestion = (rl as unknown as { _writeToOutput: unknown })._writeToOutput !== original;
        cb('secret');
      }),
    };
    const answer = await cliSurface_create(rl as unknown as import('readline').Interface)
      .prompt({ message: 'Password: ', hidden: true });
    expect(suppressedDuringQuestion).toBe(true);
    const passwordWriteIndex: number = writeSpy.mock.calls.findIndex(
      (call: Parameters<typeof process.stdout.write>): boolean => call[0] === 'Password: ',
    );
    expect(passwordWriteIndex).toBeGreaterThanOrEqual(0);
    expect(rl.question.mock.invocationCallOrder[0]).toBeLessThan(
      writeSpy.mock.invocationCallOrder[passwordWriteIndex],
    );
    // Echo restored after the answer arrives: the reinstalled hook delegates
    // back to the original (it is the original re-bound to the interface).
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput('after');
    expect(original).toHaveBeenCalledWith('after');
    expect(writeSpy).toHaveBeenCalledWith('Password: ');
    expect(answer).toBe('secret');
  });

  it('takes a hidden answer back out of the reader\'s recall, so the up arrow never brings a secret back', async () => {
    const rl = {
      history: ['an earlier line'],
      _writeToOutput: jest.fn(),
      // readline keeps the line it read before it hands it over, as the real one does.
      question: jest.fn((_p: string, cb: (a: string) => void) => { rl.history.unshift('hunter2'); cb('hunter2'); }),
    };
    expect(await cliSurface_create(rl as unknown as import('readline').Interface).prompt({ message: 'Password: ', hidden: true })).toBe('hunter2');
    expect(rl.history).toEqual(['an earlier line']);
    // An empty answer was never kept, and nothing else is taken.
    rl.question.mockImplementation((_p: string, cb: (a: string) => void) => { cb(''); });
    await cliSurface_create(rl as unknown as import('readline').Interface).prompt({ message: 'Password: ', hidden: true });
    expect(rl.history).toEqual(['an earlier line']);
  });

});

describe('local editing', () => {
  it('returns unchanged content when the editor leaves the file alone', async () => {
    const surface = cliSurface_create();
    const result = await surface.localEdit({ content: 'original text', extension: '.md' });
    expect(spawnSyncMock).toHaveBeenCalled();
    const [, editorArgs] = spawnSyncMock.mock.calls[0] as [string, string[]];
    expect(editorArgs[0]).toContain('chell-edit-');
    expect(editorArgs[0]).toContain('.md');
    expect(result).toEqual({ content: 'original text', changed: false });
  });

  it('returns the edited content with changed=true when the editor modifies it', async () => {
    const fs = await import('fs');
    spawnSyncMock.mockImplementationOnce((_editor: string, args: string[]) => {
      fs.writeFileSync(args[0], 'edited text', 'utf8');
      return { error: undefined };
    });
    const surface = cliSurface_create();
    const result = await surface.localEdit({ content: 'original text', extension: undefined });
    expect(result).toEqual({ content: 'edited text', changed: true });
  });

  it('throws when the editor fails to launch, still cleaning the temp file', async () => {
    spawnSyncMock.mockImplementationOnce(() => ({ error: new Error('ENOENT') }));
    const surface = cliSurface_create();
    // The launch failure surfaces synchronously from the surface call.
    expect(() => surface.localEdit({ content: 'x', extension: '.txt' }))
      .toThrow('failed to launch');
  });

  it('defaults the temp extension to .txt', async () => {
    const surface = cliSurface_create();
    await surface.localEdit({ content: 'x', extension: '' });
    const [, editorArgs] = spawnSyncMock.mock.calls[0] as [string, string[]];
    expect(editorArgs[0]).toContain('.txt');
  });

  describe('fileDeliver', () => {
    const tmpRoot = async (): Promise<string> => {
      const os = await import('os');
      const path = await import('path');
      return path.join(os.tmpdir(), `chell-deliver-${process.pid}`);
    };

    it('writes the delivered bytes to the resolved path', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const dir = await tmpRoot();
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, 'out.txt');

      const surface = cliSurface_create();
      const result = await surface.fileDeliver({ path: '/remote/out.txt', filename: 'out.txt', destination: target });

      expect(fs.readFileSync(target, 'utf8')).toBe('delivered bytes');
      expect(result).toEqual({ location: target, bytes: 'delivered bytes'.length });
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('treats an existing directory as a place to put the file', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const dir = await tmpRoot();
      fs.mkdirSync(dir, { recursive: true });

      const surface = cliSurface_create();
      const result = await surface.fileDeliver({ path: '/remote/x.dcm', filename: 'x.dcm', destination: dir });

      expect(result.location).toBe(path.join(dir, 'x.dcm'));
      expect(fs.existsSync(result.location)).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('a name that came from the engine stays in its folder', () => {
      /** A folder to deliver into and one beside it that nothing may reach. */
      async function folders_make(): Promise<{ base: string; into: string; beside: string }> {
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const base: string = fs.mkdtempSync(path.join(os.tmpdir(), 'chell-deliver-place-'));
        const into: string = path.join(base, 'into');
        const beside: string = path.join(base, 'beside');
        fs.mkdirSync(into);
        fs.mkdirSync(beside);
        return { base, into, beside };
      }

      /** Every file under a folder, by relative path. */
      async function files_under(folder: string): Promise<string[]> {
        const fs = await import('fs');
        return (fs.readdirSync(folder, { recursive: true, withFileTypes: true }) as import('fs').Dirent[])
          .filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
      }

      it('keeps a name with folders of its own under the destination', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const { base, into } = await folders_make();
        const result = await cliSurface_create().fileDeliver({ path: '/remote/s/anat/t1.nii', filename: 'anat/t1.nii', destination: into });
        expect(result.location).toBe(path.join(into, 'anat', 't1.nii'));
        expect(fs.readFileSync(result.location, 'utf8')).toBe('delivered bytes');
        fs.rmSync(base, { recursive: true, force: true });
      });

      it.each([
        ['../beside/x.txt', "has a '..' part"],
        ['a/../../beside/x.txt', "has a '..' part"],
        ['a\\..\\..\\beside\\x.txt', "has a '..' part"],
        ['', 'an empty name'],
      ])('refuses %j, writes nothing, and says why', async (filename: string, why: string) => {
        const fs = await import('fs');
        const { base, into, beside } = await folders_make();
        await expect(cliSurface_create().fileDeliver({ path: '/remote/x', filename, destination: into })).rejects.toThrow(why);
        await expect(cliSurface_create().fileDeliver({ path: '/remote/x', filename, destination: into })).rejects.toThrow('nothing was written');
        expect(await files_under(base)).toEqual([]);
        expect(fs.readdirSync(beside)).toEqual([]);
        fs.rmSync(base, { recursive: true, force: true });
      });

      it('refuses an absolute name, which would otherwise be written where it says', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const { base, into, beside } = await folders_make();
        const absolute: string = path.join(beside, 'x.txt');
        await expect(cliSurface_create().fileDeliver({ path: '/remote/x', filename: absolute, destination: into })).rejects.toThrow('is an absolute path');
        expect(fs.existsSync(absolute)).toBe(false);
        fs.rmSync(base, { recursive: true, force: true });
      });

      it('refuses a name that passes through a link out of the destination', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const { base, into, beside } = await folders_make();
        fs.symlinkSync(beside, path.join(into, 'sub'));
        await expect(cliSurface_create().fileDeliver({ path: '/remote/x', filename: 'sub/x.txt', destination: into })).rejects.toThrow('a link that leads outside');
        expect(fs.readdirSync(beside)).toEqual([]);
        fs.rmSync(base, { recursive: true, force: true });
      });

      it('with no destination, places the name in the working directory and nowhere above it', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const { base, into, beside } = await folders_make();
        const cwd = jest.spyOn(process, 'cwd').mockReturnValue(into);
        try {
          const result = await cliSurface_create().fileDeliver({ path: '/remote/x.txt', filename: 'x.txt' });
          expect(result.location).toBe(path.join(into, 'x.txt'));
          await expect(cliSurface_create().fileDeliver({ path: '/remote/x', filename: '../beside/x.txt' })).rejects.toThrow("has a '..' part");
          await expect(cliSurface_create().fileDeliver({ path: '/remote/x', filename: path.join(beside, 'x.txt') })).rejects.toThrow('is an absolute path');
          expect(fs.readdirSync(beside)).toEqual([]);
        } finally {
          cwd.mockRestore();
          fs.rmSync(base, { recursive: true, force: true });
        }
      });

      it('a destination that names a file is the file written, whatever name was suggested', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const { base, into } = await folders_make();
        const named: string = path.join(into, 'mine.dcm');
        const result = await cliSurface_create().fileDeliver({ path: '/remote/x', filename: '../../elsewhere.dcm', destination: named });
        expect(result.location).toBe(named);
        expect(await files_under(base)).toEqual(['mine.dcm']);
        fs.rmSync(base, { recursive: true, force: true });
      });
    });

    it('fetches through the supplied source, not the engine, when one is given', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const dir = await tmpRoot();
      fs.mkdirSync(dir, { recursive: true });
      // A remote client's engine is on another machine; it passes a fetch
      // against its daemon instead of reading a file it cannot see.
      const remoteFetch = jest.fn(async (): Promise<Buffer> => Buffer.from('from the daemon'));

      const surface = cliSurface_create(undefined, remoteFetch);
      const result = await surface.fileDeliver({
        path: '/remote/y.txt', filename: 'y.txt', destination: path.join(dir, 'y.txt'),
      });

      expect(remoteFetch).toHaveBeenCalledWith('/remote/y.txt');
      expect(fileReadMock).not.toHaveBeenCalled();
      expect(fs.readFileSync(result.location, 'utf8')).toBe('from the daemon');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('claims the engine filesystem only when it reads through the engine', () => {
      expect(cliSurface_create().capabilities.engineFilesystem).toBe(true);
      const remoteFetch = async (): Promise<Buffer> => Buffer.from('');
      expect(cliSurface_create(undefined, remoteFetch).capabilities.engineFilesystem).toBe(false);
    });
  });
});

describe('promptLine_render', () => {
  it('leaves a plain question alone', () => {
    expect(promptLine_render({ message: 'Administrator username: ' }))
      .toEqual({ message: 'Administrator username: ', fallback: '' });
  });

  it('says which letters a yes/no takes', () => {
    const shown = promptLine_render({ message: 'Overwrite? ', wants: 'confirm' });
    expect(shown.message).toBe('Overwrite? (y/n) ');
    // Enter is not an answer to a yes/no: there is no safe default to guess.
    expect(shown.fallback).toBe('');
  });

  it('offers a location composed from its anchor and suggestion', () => {
    const shown = promptLine_render({
      message: 'Where should the table go? ',
      wants: 'path',
      path: { anchor: '/home/chris', wantsDirectory: false, suggest: 'pacs.csv' },
    });
    expect(shown.message).toBe('Where should the table go? [/home/chris/pacs.csv] ');
    expect(shown.fallback).toBe('/home/chris/pacs.csv');
  });

  it('does not double the separator when the anchor ends in one', () => {
    const shown = promptLine_render({
      message: 'where? ',
      wants: 'path',
      path: { anchor: '/home/chris/', wantsDirectory: false, suggest: 'x.csv' },
    });
    expect(shown.fallback).toBe('/home/chris/x.csv');
  });

  // The anchor says where to LOOK, not what to offer: proposing it would
  // answer a move with the folder the file is already in.
  it('offers nothing when the question suggests nothing', () => {
    const shown = promptLine_render({
      message: 'which folder? ',
      wants: 'path',
      path: { anchor: '/home/chris/audits', wantsDirectory: true },
    });
    expect(shown.message).toBe('which folder? ');
    expect(shown.fallback).toBe('');
  });

  it('offers nothing when a location ask suggests nothing', () => {
    const shown = promptLine_render({ message: 'where? ', wants: 'path', path: { wantsDirectory: false } });
    expect(shown.message).toBe('where? ');
    expect(shown.fallback).toBe('');
  });

  // A daemon that predates typed asks sends `hidden` and nothing else, and
  // its questions must read exactly as they always did.
  it('reads an older prompt as the plain line it always was', () => {
    expect(promptLine_render({ message: 'Password: ', hidden: true }).message).toBe('Password: ');
  });
});

describe('promptAnswer_take', () => {
  it('takes the offer when the line is empty', () => {
    expect(promptAnswer_take('', '/home/chris/x.csv')).toBe('/home/chris/x.csv');
    expect(promptAnswer_take('   ', '/home/chris/x.csv')).toBe('/home/chris/x.csv');
  });

  it('takes what was typed over what was offered', () => {
    expect(promptAnswer_take('  /elsewhere/y.csv ', '/home/chris/x.csv')).toBe('/elsewhere/y.csv');
  });

  // A question with nothing to offer answers with nothing, which the caller
  // reads as an abandonment rather than as a path named ''.
  it('answers with nothing when there was nothing to offer', () => {
    expect(promptAnswer_take('', '')).toBe('');
  });
});
