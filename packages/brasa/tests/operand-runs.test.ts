/**
 * @file The runs of a `/bin` line (#1449): several directory operands are
 * several runs, every operand checked before any starts.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const home: string = '/home/u';
jest.unstable_mockModule('../src/core/paths.js', () => ({
  path_resolve: async (input: string): Promise<string> => input.startsWith('~/') ? `${home}/${input.slice(2)}` : input,
}));
jest.unstable_mockModule('../src/core/filesystem.js', () => ({ vfsDispatcher_get: () => { throw new Error('the dispatcher is not used here'); } }));
cuminMock_install(() => ({
  path_isInFeed: (path: string): boolean => path.includes('/feeds/feed_'),
  path_extractPluginInstanceID: (path: string): number | null => { const found = path.match(/\/pl-[^/]+_(\d+)(\/|$)/); return found ? Number(found[1]) : null; },
}));

const { operands_read } = await import('../src/builtins/operands.js');
const { operandRuns_split } = await import('../src/builtins/operandRuns.js');
type PathKind = 'directory' | 'file' | 'missing';

/** A filesystem by path. */
const world = (entries: Record<string, PathKind>) => async (resolved: string): Promise<PathKind> => entries[resolved] ?? 'missing';

describe('operandRuns_split', () => {
  const fs = world({
    '/home/u/uploads/sub-01': 'directory', '/home/u/uploads/sub-02': 'directory', '/home/u/uploads/t1.nii': 'file',
    '/home/u/feeds/feed_3/pl-dircopy_12/data': 'directory', '/home/u/feeds/feed_3/data': 'directory',
  });

  it('reads several directories, in order, and makes one run of each with the plugin words after it', async () => {
    const read = await operands_read(['~/uploads/sub-01', '~/uploads/sub-02', '--threads', '2'], fs);
    expect(read.directories).toEqual(['/home/u/uploads/sub-01', '/home/u/uploads/sub-02']);
    expect(await operandRuns_split(['~/uploads/sub-01', '~/uploads/sub-02', '--threads', '2'], fs)).toEqual([
      ['~/uploads/sub-01', '--threads', '2'],
      ['~/uploads/sub-02', '--threads', '2'],
    ]);
    // Inside the tree and outside it mix: each operand is placed on its own.
    expect(await operandRuns_split(['~/uploads/sub-01', '~/feeds/feed_3/pl-dircopy_12/data'], fs)).toHaveLength(2);
  });

  it('leaves a line with one directory, files, or nothing as one run, word for word', async () => {
    expect(await operandRuns_split(['~/uploads/sub-01', '--threads', '2'], fs)).toEqual([['~/uploads/sub-01', '--threads', '2']]);
    expect(await operandRuns_split(['~/uploads/t1.nii', 'as', 's'], fs)).toEqual([['~/uploads/t1.nii', 'as', 's']]);
    expect(await operandRuns_split(['--threads', '2'], fs)).toEqual([['--threads', '2']]);
  });

  it('refuses the whole line when one operand would refuse: missing, beside a file, or in a feed but not at a node', async () => {
    await expect(operandRuns_split(['~/uploads/sub-01', '~/uploads/none'], fs)).rejects.toThrow('~/uploads/none: no such file or directory');
    await expect(operandRuns_split(['~/uploads/sub-01', '~/uploads/sub-02', '~/uploads/t1.nii'], fs)).rejects.toThrow('do not mix');
    await expect(operandRuns_split(['~/uploads/sub-01', '~/feeds/feed_3/data'], fs)).rejects.toThrow('~/feeds/feed_3/data is in a feed but not at a node');
  });
});
