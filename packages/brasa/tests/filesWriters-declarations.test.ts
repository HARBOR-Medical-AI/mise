/**
 * @file `rm`, `rmdir`, `mkdir` and `touch`, each declared in one record: a
 * bad line is refused in the parser's words before the handler runs (the
 * store is never asked), `--` ends the options, a typed option reaches the
 * handler, and each keeps its help category and holds the whole session.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));

const { linkedStore_install, HOME } = await import('./support/linkedStore.js');
const { rmCommand, builtin_rm } = await import('../src/builtins/fs/rm.js');
const { rmdirCommand, builtin_rmdir } = await import('../src/builtins/fs/rmdir.js');
const { mkdirCommand, builtin_mkdir } = await import('../src/builtins/fs/mkdir.js');
const { touchCommand, builtin_touch } = await import('../src/builtins/fs/touch.js');
const { commandUsage_render } = await import('../src/core/commandUsage.js');

type LinkedStore = ReturnType<typeof linkedStore_install>;
type Builtin = (args: string[]) => Promise<{ status: string; renderedErr?: string }>;

let store: LinkedStore;

beforeEach((): void => {
  process.exitCode = 0;
  store = linkedStore_install();
});

describe('the Files writers refuse a bad line before the handler', () => {
  it.each([
    ['rm', builtin_rm, ['-q', 'x'], "rm: invalid option -- 'q'; usage: "],
    ['rm', builtin_rm, ['--verbose', 'x'], "rm: unrecognized option '--verbose'; usage: "],
    ['rm', builtin_rm, [], 'rm: missing operand <paths>; usage: '],
    ['rmdir', builtin_rmdir, ['-p', 'x'], "rmdir: invalid option -- 'p'; usage: "],
    ['mkdir', builtin_mkdir, ['--mode=700', 'x'], "mkdir: unrecognized option '--mode'; usage: "],
    ['touch', builtin_touch, ['-p', 'x'], "touch: invalid option -- 'p'; usage: "],
    ['touch', builtin_touch, ['--withContents'], "touch: option '--withContents' wants a value (<string>); usage: "],
  ] as Array<[string, Builtin, string[], string]>)('%s %j', async (_name: string, builtin: Builtin, args: string[], refusal: string) => {
    const envelope = await builtin(args);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain(refusal);
    expect(process.exitCode).toBe(1);
    expect(store.calls).toEqual([]);
  });
});

describe('-- ends the options', () => {
  it('rm removes a file whose name starts with a dash', async () => {
    store.entries.set(`${HOME}/-odd`, { type: 'file', content: '' });
    expect((await builtin_rm(['--', '-odd'])).status).toBe('ok');
    expect(store.entries.has(`${HOME}/-odd`)).toBe(false);
  });

  it('rmdir removes a folder whose name starts with a dash', async () => {
    store.entries.set(`${HOME}/-d`, { type: 'dir' });
    expect((await builtin_rmdir(['--', '-d'])).status).toBe('ok');
    expect(store.entries.has(`${HOME}/-d`)).toBe(false);
  });

  it('mkdir makes a folder named -p', async () => {
    expect((await builtin_mkdir(['--', '-p'])).status).toBe('ok');
    expect(store.entries.get(`${HOME}/-p`)).toEqual({ type: 'dir' });
  });

  it('touch makes a file whose name starts with a dash', async () => {
    expect((await builtin_touch(['--', '-n'])).status).toBe('ok');
    expect(store.entries.get(`${HOME}/-n`)).toEqual({ type: 'file', content: '' });
  });
});

describe('a typed option reaches the handler', () => {
  it('rm -R is -r: a folder goes with all it holds', async () => {
    store.entries.set(`${HOME}/scratch`, { type: 'dir' });
    store.entries.set(`${HOME}/scratch/f`, { type: 'file', content: 'x' });
    expect((await builtin_rm(['-R', 'scratch'])).status).toBe('ok');
    expect(store.entries.has(`${HOME}/scratch`)).toBe(false);
    expect(store.entries.has(`${HOME}/scratch/f`)).toBe(false);
  });

  it('rm -f says nothing of a path not there', async () => {
    const envelope = await builtin_rm(['gone', '-f']);
    expect(envelope.status).toBe('ok');
  });

  it('mkdir --parents makes the folders along the way', async () => {
    expect((await builtin_mkdir(['x/y', '--parents'])).status).toBe('ok');
    expect(store.entries.get(`${HOME}/x/y`)).toEqual({ type: 'dir' });
  });

  it('touch --withContents=text writes it, an empty value included', async () => {
    expect((await builtin_touch(['--withContents=- item', 'list.yaml'])).status).toBe('ok');
    expect(store.entries.get(`${HOME}/list.yaml`)).toEqual({ type: 'file', content: '- item' });
    expect((await builtin_touch(['--withContents', '', 'empty.txt'])).status).toBe('ok');
    expect(store.entries.get(`${HOME}/empty.txt`)).toEqual({ type: 'file', content: '' });
  });
});

describe('their declarations', () => {
  it('generate their usage from the grammar', () => {
    expect(commandUsage_render(rmCommand, null)).toContain('<paths…>');
    expect(commandUsage_render(rmdirCommand, null)).toContain('<paths…>');
    expect(commandUsage_render(mkdirCommand, null)).toContain('<paths…>');
    expect(commandUsage_render(touchCommand, null)).toContain('--withContents <string>');
  });

  it('list under Files and hold the whole session', () => {
    for (const declaration of [rmCommand, rmdirCommand, mkdirCommand, touchCommand]) {
      expect(declaration.help.category).toBe('Files');
      expect(declaration.holds).toBeUndefined();
    }
  });
});
