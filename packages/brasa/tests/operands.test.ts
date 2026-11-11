/**
 * @file The input operand of a `/bin` run (#1303): the grammar, the subject
 * names, what a path is read as, and the stage file operands are shaped into.
 */
import { describe, it, expect, jest } from '@jest/globals';

const home: string = '/home/u';
jest.unstable_mockModule('../src/core/paths.js', () => ({
  path_resolve: async (input: string): Promise<string> => input === '~' ? home : input.startsWith('~/') ? `${home}/${input.slice(2)}` : input.startsWith('/') ? input : `${home}/${input}`,
}));
jest.unstable_mockModule('../src/core/filesystem.js', () => ({ vfsDispatcher_get: () => { throw new Error('the dispatcher is not used here'); } }));

const { operandTokens_split, operands_read, subjectStem_derive, stage_make, stage_lines, stageMade_lines, OperandRefusal } = await import('../src/builtins/operands.js');
type PathKind = 'directory' | 'file' | 'missing';

/** A filesystem by path. */
const world = (entries: Record<string, PathKind>) => async (resolved: string): Promise<PathKind> => entries[resolved] ?? 'missing';

describe('operandTokens_split', () => {
  it('takes the leading words as operands and leaves the plugin its flags', () => {
    expect(operandTokens_split(['~/uploads/subjects', '--threads', '2'])).toEqual({ clauses: [{ kind: 'path', value: '~/uploads/subjects' }], rest: ['--threads', '2'] });
    expect(operandTokens_split(['--threads=2', 't1.nii', 'as', 'sub-01', '--verbose'])).toEqual({
      clauses: [{ kind: 'path', value: 't1.nii' }, { kind: 'as', name: 'sub-01' }], rest: ['--threads=2', '--verbose'],
    });
    expect(operandTokens_split(['--verbose', 't1.nii'])).toEqual({ clauses: [], rest: ['--verbose', 't1.nii'] });
    expect(operandTokens_split([])).toEqual({ clauses: [], rest: [] });
  });

  it('reads as as a keyword only after a path and before a name', () => {
    expect(operandTokens_split(['as'])).toEqual({ clauses: [{ kind: 'path', value: 'as' }], rest: [] });
    expect(operandTokens_split(['as', 't1.nii'])).toEqual({ clauses: [{ kind: 'path', value: 'as' }, { kind: 'path', value: 't1.nii' }], rest: [] });
    expect(() => operandTokens_split(['t1.nii', 'as'])).toThrow(OperandRefusal);
    expect(() => operandTokens_split(['t1.nii', 'as', '--verbose'])).toThrow('as needs a name');
    expect(() => operandTokens_split(['t1.nii', 'as', 'a/b'])).toThrow('no /');
  });

  it('keeps a bare key=value for the plugin unless its key is a path', () => {
    expect(operandTokens_split(['x=1', 't1.nii'])).toEqual({ clauses: [{ kind: 'path', value: 't1.nii' }], rest: ['x=1'] });
    expect(operandTokens_split(['~/a=b/t1.nii'])).toEqual({ clauses: [{ kind: 'path', value: '~/a=b/t1.nii' }], rest: [] });
  });
});

describe('subjectStem_derive', () => {
  it('strips a compound extension whole, else the last one', () => {
    expect(subjectStem_derive('/x/t1.nii.gz')).toBe('t1');
    expect(subjectStem_derive('/x/a.tar.gz')).toBe('a');
    expect(subjectStem_derive('/x/t1.nii')).toBe('t1');
    expect(subjectStem_derive('/x/sub.01.mgz')).toBe('sub.01');
    expect(subjectStem_derive('/x/README')).toBe('README');
  });
});

describe('operands_read', () => {
  const fs = world({ '/home/u/uploads/subjects': 'directory', '/home/u/uploads/t1.nii': 'file', '/home/u/uploads/t2.nii': 'file', '/home/u/uploads/t1.nii.gz': 'file' });

  it('reads nothing as nothing, a directory as the input, and files as subjects named by their stems', async () => {
    expect(await operands_read(['--threads', '2'], fs)).toEqual({ directory: null, directories: [], subjects: [], typed: [], rest: ['--threads', '2'] });
    expect(await operands_read(['~/uploads/subjects', '--threads', '2'], fs)).toEqual({ directory: '/home/u/uploads/subjects', directories: ['/home/u/uploads/subjects'], subjects: [], typed: ['~/uploads/subjects'], rest: ['--threads', '2'] });
    expect(await operands_read(['~/uploads/t1.nii', 'uploads/t2.nii'], fs)).toEqual({
      directory: null, directories: [], typed: ['~/uploads/t1.nii', 'uploads/t2.nii'], rest: [],
      subjects: [
        { name: 't1', named: false, typed: ['~/uploads/t1.nii'], files: ['/home/u/uploads/t1.nii'] },
        { name: 't2', named: false, typed: ['uploads/t2.nii'], files: ['/home/u/uploads/t2.nii'] },
      ],
    });
  });

  it('groups the files since the last as under one named subject', async () => {
    const read = await operands_read(['~/uploads/t1.nii', '~/uploads/t2.nii', 'as', 'sub-01'], fs);
    expect(read.subjects).toEqual([{ name: 'sub-01', named: true, typed: ['~/uploads/t1.nii', '~/uploads/t2.nii'], files: ['/home/u/uploads/t1.nii', '/home/u/uploads/t2.nii'] }]);
    const two = await operands_read(['~/uploads/t1.nii', 'as', 's1', '~/uploads/t2.nii', 'as', 's2'], fs);
    expect(two.subjects.map((subject) => subject.name)).toEqual(['s1', 's2']);
  });

  it('refuses a missing path, a pattern matching nothing, a directory with as, a directory beside files, and two subjects of one name', async () => {
    await expect(operands_read(['~/uploads/nothing.nii'], fs)).rejects.toThrow('no such file or directory');
    await expect(operands_read(['~/uploads/subjects', 'as', 'x'], fs)).rejects.toThrow('a tree is already named');
    await expect(operands_read(['~/feeds/feed_9*'], fs)).rejects.toThrow('~/feeds/feed_9*: no match');
    await expect(operands_read(['~/uploads/subjects', '~/uploads/t1.nii'], fs)).rejects.toThrow('do not mix');
    await expect(operands_read(['~/uploads/t1.nii', '~/uploads/subjects'], fs)).rejects.toThrow('do not mix');
    await expect(operands_read(['~/uploads/t1.nii', '~/uploads/t1.nii.gz'], fs)).rejects.toThrow('two subjects would be called t1');
  });
});

describe('stage_make', () => {
  it('makes a folder per subject under ~/.mise/stage/<id> and copies each file into it, and says what it made', async () => {
    const made: string[] = [];
    const copied: Array<[string, string]> = [];
    const writer = { folder_make: async (folder: string) => { made.push(folder); return { ok: true as const, value: true as const }; }, file_copy: async (source: string, destination: string) => { copied.push([source, destination]); return { ok: true as const, value: true as const }; } };
    const subjects = [
      { name: 'sub-01', named: true, typed: ['t1.nii', 't2.nii'], files: ['/home/u/uploads/t1.nii', '/home/u/uploads/t2.nii'] },
      { name: 'x', named: false, typed: ['x.nii.gz'], files: ['/home/u/uploads/x.nii.gz'] },
    ];
    const stage = await stage_make(subjects, '/home/u', writer, '20261030-120000-abcd');
    expect(stage.path).toBe('/home/u/.mise/stage/20261030-120000-abcd');
    expect(stage.trace).toBe('home_u_.mise_stage_20261030-120000-abcd');
    expect(made).toEqual(['/home/u/.mise/stage/20261030-120000-abcd', '/home/u/.mise/stage/20261030-120000-abcd/sub-01', '/home/u/.mise/stage/20261030-120000-abcd/x']);
    expect(copied).toEqual([
      ['/home/u/uploads/t1.nii', '/home/u/.mise/stage/20261030-120000-abcd/sub-01/t1.nii'],
      ['/home/u/uploads/t2.nii', '/home/u/.mise/stage/20261030-120000-abcd/sub-01/t2.nii'],
      ['/home/u/uploads/x.nii.gz', '/home/u/.mise/stage/20261030-120000-abcd/x/x.nii.gz'],
    ]);
    expect(stage_lines(stage)).toEqual(['subject sub-01 from t1.nii t2.nii', 'subject x from x.nii.gz']);
    expect(stageMade_lines(stage, '/home/u/feeds/feed_9/pl-dircopy_40/data')).toEqual([
      'made /home/u/feeds/feed_9/pl-dircopy_40/data/home_u_.mise_stage_20261030-120000-abcd/sub-01/t1.nii',
      'made /home/u/feeds/feed_9/pl-dircopy_40/data/home_u_.mise_stage_20261030-120000-abcd/sub-01/t2.nii',
      'made /home/u/feeds/feed_9/pl-dircopy_40/data/home_u_.mise_stage_20261030-120000-abcd/x/x.nii.gz',
    ]);
  });

  it('refuses when a folder cannot be made or a copy fails, never merging', async () => {
    const writer = { folder_make: async (folder: string) => folder.endsWith('/sub-01') ? { ok: false as const, errno: 'EEXIST' as never } : { ok: true as const, value: true as const }, file_copy: async () => ({ ok: true as const, value: true as const }) };
    await expect(stage_make([{ name: 'sub-01', named: true, typed: ['t1.nii'], files: ['/home/u/t1.nii'] }], '/home/u', writer, 'id')).rejects.toThrow('could not make /home/u/.mise/stage/id/sub-01');
  });
});
